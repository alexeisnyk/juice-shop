/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const path = require('path')
const sinon = require('sinon')

describe('uploadDownload', () => {
  const downloadUploadedFile = require('../../routes/uploadDownload')
  const insecurity = require('../../lib/insecurity')
  const token = 'upload-download-test-token'
  const user = { data: { id: 4242, email: 'user@juice-sh.op' } }

  beforeEach(() => {
    insecurity.authenticatedUsers.put(token, user)
    this.req = { cookies: { token }, query: {}, headers: {}, ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' } }
    this.res = { download: sinon.spy(), status: sinon.spy(), setHeader: sinon.spy(), headersSent: false }
    this.next = sinon.spy()
  })

  afterEach(() => {
    delete insecurity.authenticatedUsers.tokenMap[token]
    delete insecurity.authenticatedUsers.idMap[user.data.id]
  })

  const dispatch = () => {
    downloadUploadedFile()(this.req, this.res, this.next)
    return new Promise((resolve) => setImmediate(resolve))
  }

  it('should download a file from the uploads directory for a logged-in user', async () => {
    this.req.query.filename = 'complaints/.gitkeep'

    await dispatch()

    sinon.assert.calledWith(this.res.download, path.resolve('uploads/complaints/.gitkeep'), '.gitkeep')
    sinon.assert.notCalled(this.next)
  })

  it('should accept a bearer token for a logged-in user', async () => {
    this.req.cookies = {}
    this.req.headers.authorization = 'Bearer ' + token
    this.req.query.filename = 'complaints/.gitkeep'

    await dispatch()

    sinon.assert.calledOnce(this.res.download)
    sinon.assert.notCalled(this.next)
  })

  it('should reject anonymous requests', async () => {
    this.req.cookies = {}
    this.req.query.filename = 'complaints/.gitkeep'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 401)
    sinon.assert.notCalled(this.res.download)
    sinon.assert.calledWith(this.next, sinon.match.instanceOf(Error))
  })

  it('should reject a missing filename', async () => {
    await dispatch()

    sinon.assert.calledWith(this.res.status, 400)
    sinon.assert.notCalled(this.res.download)
  })

  it('should reject filenames that leave the uploads directory', async () => {
    this.req.query.filename = '../server.js'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 403)
    sinon.assert.notCalled(this.res.download)
    sinon.assert.calledWith(this.next, sinon.match.instanceOf(Error))
  })

  it('should reject nested paths that leave the uploads directory', async () => {
    this.req.query.filename = 'complaints/../../server.js'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 403)
    sinon.assert.notCalled(this.res.download)
  })

  it('should reject absolute filenames', async () => {
    this.req.query.filename = '/etc/passwd'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 403)
    sinon.assert.notCalled(this.res.download)
  })

  it('should reject a null byte in the filename', async () => {
    this.req.query.filename = 'complaints/.gitkeep%00.md'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 400)
    sinon.assert.notCalled(this.res.download)
  })

  it('should return not found when the file does not exist', async () => {
    this.req.query.filename = 'complaints/missing-file.txt'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 404)
    sinon.assert.notCalled(this.res.download)
  })

  it('should not download a directory', async () => {
    this.req.query.filename = 'complaints'

    await dispatch()

    sinon.assert.calledWith(this.res.status, 404)
    sinon.assert.notCalled(this.res.download)
  })
})
