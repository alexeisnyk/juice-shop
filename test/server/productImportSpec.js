/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const sinon = require('sinon')
const chai = require('chai')
const expect = chai.expect

describe('productImport', () => {
  const productImport = require('../../routes/productImport')
  const insecurity = require('../../lib/insecurity')
  const models = require('../../models/index')

  const adminToken = crypto.randomBytes(16).toString('hex')
  const customerToken = crypto.randomBytes(16).toString('hex')
  const admin = { data: { id: 4242, email: 'admin@juice-sh.op', role: 'admin' } }
  const customer = { data: { id: 4243, email: 'user@juice-sh.op', role: 'customer' } }
  const importRoot = path.resolve('uploads/products')
  const escapedName = 'product-import-escaped.txt'
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )

  let createStub
  let existingImports

  beforeEach(() => {
    insecurity.authenticatedUsers.put(adminToken, admin)
    insecurity.authenticatedUsers.put(customerToken, customer)
    existingImports = fs.existsSync(importRoot) ? fs.readdirSync(importRoot) : []
    let nextId = 50
    createStub = sinon.stub(models.Product, 'create').callsFake((data) => {
      nextId += 1
      return Promise.resolve(Object.assign({ id: nextId }, data))
    })
  })

  afterEach(() => {
    delete insecurity.authenticatedUsers.tokenMap[adminToken]
    delete insecurity.authenticatedUsers.tokenMap[customerToken]
    delete insecurity.authenticatedUsers.idMap[admin.data.id]
    delete insecurity.authenticatedUsers.idMap[customer.data.id]
    if (createStub) {
      createStub.restore()
    }
    removeCreatedImports(existingImports)
    ;[escapedName, path.join('uploads', escapedName)].forEach((relative) => {
      const target = path.resolve(relative)
      if (fs.existsSync(target)) {
        fs.unlinkSync(target)
      }
    })
  })

  it('extracts catalog images into the uploads folder and creates products', async () => {
    const catalog = {
      products: [{
        name: 'Bulk Apple',
        description: 'Tasty',
        price: 1.5,
        deluxePrice: 1,
        image: 'images/apple.png'
      }]
    }
    const res = mockRes()

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: JSON.stringify(catalog) },
      { name: 'images/apple.png', data: png }
    ]), res)

    expect(res.statusCode).to.equal(201)
    expect(res.body.status).to.equal('success')
    expect(res.body.importId).to.match(/^[a-f0-9]{32}$/)
    expect(res.body.data).to.deep.equal([{
      id: 51,
      name: 'Bulk Apple',
      description: 'Tasty',
      price: 1.5,
      deluxePrice: 1,
      image: 'apple.png'
    }])
    const created = newImportDirectories(existingImports)
    expect(created).to.deep.equal([res.body.importId])
    const imagePath = path.join(importRoot, created[0], 'images', 'apple.png')
    expect(fs.readFileSync(imagePath).equals(png)).to.equal(true)
    expect(fs.existsSync(path.join(importRoot, created[0], 'catalog.json'))).to.equal(true)
    expect(path.relative(importRoot, imagePath).split(path.sep)).to.not.include('..')
  })

  it('accepts an admin bearer token', async () => {
    const catalog = {
      products: [{ name: 'Pear', description: '', price: 2, image: 'pear.png' }]
    }
    const req = multipartRequest('catalog.zip', zipOf([
      { name: 'catalog.json', data: JSON.stringify(catalog) },
      { name: 'pear.png', data: png }
    ]))
    req.cookies = {}
    req.headers.authorization = 'Bearer ' + adminToken
    const res = mockRes()

    await productImport()(req, res, sinon.spy())

    expect(res.statusCode).to.equal(201)
    expect(createStub.calledOnce).to.equal(true)
  })

  it('rejects anonymous uploads', async () => {
    const res = mockRes()
    const next = sinon.spy()

    await dispatch(null, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: '{"products":[]}' },
      { name: 'apple.png', data: png }
    ]), res, next)

    expect(res.statusCode).to.equal(401)
    expect(createStub.called).to.equal(false)
    expect(next.called).to.equal(false)
  })

  it('rejects a customer upload', async () => {
    const res = mockRes()

    await dispatch(customerToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: '{"products":[]}' }
    ]), res)

    expect(res.statusCode).to.equal(403)
    expect(createStub.called).to.equal(false)
    expect(newImportDirectories(existingImports)).to.have.length(0)
  })

  it('rejects an archive entry that leaves the uploads folder', async () => {
    const res = mockRes()
    const catalog = {
      products: [{ name: 'Nope', description: 'Nope', price: 1, image: escapedName }]
    }

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: JSON.stringify(catalog) },
      { name: '../../' + escapedName, data: Buffer.from('escaped') }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(createStub.called).to.equal(false)
    expect(fs.existsSync(path.resolve(escapedName))).to.equal(false)
    expect(fs.existsSync(path.resolve('uploads', escapedName))).to.equal(false)
    expect(newImportDirectories(existingImports)).to.have.length(0)
  })

  it('rejects a nested entry that leaves the uploads folder', async () => {
    const res = mockRes()

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: '{"products":[]}' },
      { name: 'images/../../' + escapedName, data: png }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(fs.existsSync(path.resolve(escapedName))).to.equal(false)
    expect(newImportDirectories(existingImports)).to.have.length(0)
  })

  it('rejects an absolute archive path', async () => {
    const res = mockRes()

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: '{"products":[]}' },
      { name: '/tmp/' + escapedName, data: png }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(fs.existsSync(path.join('/tmp', escapedName))).to.equal(false)
  })

  it('rejects a catalog image that is not in the archive', async () => {
    const res = mockRes()
    const catalog = {
      products: [{ name: 'Ghost', description: 'Missing', price: 3, image: '../server.js' }]
    }

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: JSON.stringify(catalog) },
      { name: 'apple.png', data: png }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(createStub.called).to.equal(false)
  })

  it('rejects markup in the catalog text', async () => {
    const res = mockRes()
    const catalog = {
      products: [{
        name: 'Safe name',
        description: '<script>alert(1)</script>',
        price: 1,
        image: 'apple.png'
      }]
    }

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: JSON.stringify(catalog) },
      { name: 'apple.png', data: png }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(createStub.called).to.equal(false)
  })

  it('rejects a file that is not an image or catalog', async () => {
    const res = mockRes()

    await dispatch(adminToken, 'catalog.zip', zipOf([
      { name: 'catalog.json', data: '{"products":[]}' },
      { name: 'notes.html', data: Buffer.from('<html></html>') }
    ]), res)

    expect(res.statusCode).to.equal(400)
    expect(newImportDirectories(existingImports)).to.have.length(0)
  })

  it('rejects a non-zip upload', async () => {
    const res = mockRes()

    await dispatch(adminToken, 'catalog.txt', Buffer.from('not a zip'), res)

    expect(res.statusCode).to.equal(400)
    expect(res.body.message).to.equal('A zip archive is required')
  })

  function dispatch (token, filename, content, res, next) {
    const req = multipartRequest(filename, content)
    if (!token) {
      req.cookies = {}
    } else {
      req.cookies = { token }
    }
    return productImport()(req, res, next || sinon.spy())
  }

  function multipartRequest (filename, content) {
    const boundary = '----JuiceShopProductImport'
    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'
    )
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
    const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail])
    const req = new Readable({
      read () {
        this.push(body)
        this.push(null)
      }
    })
    req.headers = {
      'content-type': 'multipart/form-data; boundary=' + boundary,
      'content-length': String(body.length)
    }
    req.ip = '127.0.0.1'
    req.connection = { remoteAddress: '127.0.0.1' }
    return req
  }

  function mockRes () {
    return {
      statusCode: null,
      body: null,
      headersSent: false,
      status (code) {
        this.statusCode = code
        return this
      },
      json (payload) {
        this.body = payload
        return this
      },
      send (payload) {
        this.body = payload
        return this
      },
      setHeader () {},
      getHeader () { return undefined },
      header () { return this }
    }
  }

  function newImportDirectories (before) {
    if (!fs.existsSync(importRoot)) {
      return []
    }
    return fs.readdirSync(importRoot).filter((name) => before.indexOf(name) === -1)
  }

  function removeCreatedImports (before) {
    newImportDirectories(before).forEach((name) => {
      removeTree(path.join(importRoot, name))
    })
    if (fs.existsSync(importRoot) && fs.readdirSync(importRoot).length === 0 && before.length === 0) {
      fs.rmdirSync(importRoot)
    }
  }

  function removeTree (target) {
    if (!fs.existsSync(target)) {
      return
    }
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.unlinkSync(target)
      return
    }
    fs.readdirSync(target).forEach((name) => removeTree(path.join(target, name)))
    fs.rmdirSync(target)
  }
})

function zipOf (files) {
  const locals = []
  const centrals = []
  let offset = 0
  files.forEach((file) => {
    const name = Buffer.from(file.name)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    data.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  })
  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat(locals.concat([centralDir, end]))
}

function crc32 (buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
