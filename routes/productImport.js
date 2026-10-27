/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const RateLimit = require('express-rate-limit')
const multer = require('multer')
const unzipper = require('unzipper')
const models = require('../models/index')
const insecurity = require('../lib/insecurity')

const UPLOADS_ROOT = path.resolve(__dirname, '../uploads/products')
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 40
const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 100
const MAX_PRODUCTS = 30
const MAX_PATH_SEGMENTS = 4
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
})

const importLimiter = new RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  delayMs: 0,
  keyGenerator ({ ip }) { return ip || 'unknown' }
})

module.exports = function productImport () {
  return (req, res, next) => {
    return new Promise((resolve) => {
      importLimiter(req, res, (err) => {
        if (err) {
          next(err)
          resolve()
          return
        }
        upload.single('file')(req, res, (uploadErr) => {
          if (uploadErr) {
            res.status(400).json({ status: 'error', message: 'Invalid upload' })
            resolve()
            return
          }
          Promise.resolve(processProductImport(req, res, next)).catch(next).then(resolve)
        })
      })
    })
  }
}

function processProductImport (req, res, next) {
  const user = userFromRequest(req)
  if (!user) {
    res.status(401).json({ status: 'error', message: 'Unauthorized' })
    return
  }
  if (!user.data || user.data.role !== insecurity.roles.admin) {
    res.status(403).json({ status: 'error', message: 'Admin access required' })
    return
  }
  if (!req.file || !req.file.buffer || !isZipUpload(req.file)) {
    res.status(400).json({ status: 'error', message: 'A zip archive is required' })
    return
  }

  return importArchive(req.file.buffer).then((result) => {
    res.status(201).json({ status: 'success', importId: result.importId, data: result.products })
  }).catch((err) => {
    if (err && err.statusCode) {
      res.status(err.statusCode).json({ status: 'error', message: err.message })
      return
    }
    next(err)
  })
}

async function importArchive (buffer) {
  const entryCount = declaredEntryCount(buffer)
  if (entryCount === null || entryCount < 1 || entryCount > MAX_ENTRIES) {
    throw httpError(400, 'Archive has an invalid number of files')
  }

  let directory
  try {
    directory = await unzipper.Open.buffer(buffer)
  } catch (err) {
    throw httpError(400, 'Invalid zip archive')
  }

  const records = Array.isArray(directory.files) ? directory.files : []
  if (records.length === 0 || records.length > MAX_ENTRIES) {
    throw httpError(400, 'Archive has an invalid number of files')
  }

  const planned = []
  const seen = new Set()
  let declaredTotal = 0
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]
    if (isDirectoryEntry(entry)) {
      continue
    }
    if (isLinkEntry(entry) || isEncrypted(entry) || !isSupportedCompression(entry)) {
      throw httpError(400, 'Archive contains an unsupported entry')
    }
    const relative = safeRelativePath(entry.path)
    if (!relative) {
      throw httpError(400, 'Archive contains an invalid path')
    }
    if (seen.has(relative)) {
      throw httpError(400, 'Archive contains a duplicate path')
    }
    seen.add(relative)
    const uncompressed = entry.uncompressedSize || 0
    const compressed = entry.compressedSize || 0
    if (uncompressed > MAX_ENTRY_BYTES || compressed > MAX_ENTRY_BYTES) {
      throw httpError(400, 'Archive entry is too large')
    }
    if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
      throw httpError(400, 'Archive entry is too large')
    }
    declaredTotal += uncompressed
    if (declaredTotal > MAX_TOTAL_BYTES) {
      throw httpError(400, 'Archive is too large')
    }
    planned.push({ entry, relative, compressed })
  }

  if (planned.length === 0) {
    throw httpError(400, 'Archive has an invalid number of files')
  }

  const files = new Map()
  let actualTotal = 0
  for (let i = 0; i < planned.length; i++) {
    const item = planned[i]
    const data = await readCapped(item.entry, MAX_ENTRY_BYTES)
    if (item.compressed > 0 && data.length / item.compressed > MAX_COMPRESSION_RATIO) {
      throw httpError(400, 'Archive entry is too large')
    }
    actualTotal += data.length
    if (actualTotal > MAX_TOTAL_BYTES) {
      throw httpError(400, 'Archive is too large')
    }
    const ext = path.extname(item.relative).toLowerCase()
    const isCatalog = item.relative === 'catalog.json'
    if (!isCatalog && (!IMAGE_EXTENSIONS.has(ext) || !hasImageMagic(data, ext))) {
      throw httpError(400, 'Archive may only contain catalog.json and images')
    }
    files.set(item.relative, data)
  }

  if (!files.has('catalog.json')) {
    throw httpError(400, 'Archive must contain catalog.json')
  }

  const products = parseCatalog(files.get('catalog.json'), files)
  const importId = crypto.randomBytes(16).toString('hex')
  const importRoot = await createImportDirectory(importId)
  const createdIds = []
  try {
    writeExtractedFiles(importRoot, files)
    for (let i = 0; i < products.length; i++) {
      const product = products[i]
      const row = await models.Product.create({
        name: product.name,
        description: product.description,
        price: product.price,
        deluxePrice: product.deluxePrice,
        image: product.image
      })
      createdIds.push(row.id)
    }
  } catch (err) {
    try {
      removeTree(UPLOADS_ROOT, importRoot)
    } catch (cleanupError) {
      /* Keep the original import error. */
    }
    if (createdIds.length > 0) {
      await models.Product.destroy({ where: { id: createdIds }, force: true }).catch(() => {})
    }
    throw err
  }

  return {
    importId,
    products: products.map((product, index) => {
      return {
        id: createdIds[index],
        name: product.name,
        description: product.description,
        price: product.price,
        deluxePrice: product.deluxePrice,
        image: product.image
      }
    })
  }
}

function parseCatalog (buffer, files) {
  if (buffer.length > MAX_ENTRY_BYTES) {
    throw httpError(400, 'catalog.json is too large')
  }
  let catalog
  try {
    catalog = JSON.parse(buffer.toString('utf8'))
  } catch (err) {
    throw httpError(400, 'catalog.json is not valid JSON')
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || !Array.isArray(catalog.products)) {
    throw httpError(400, 'catalog.json must contain a products array')
  }
  if (catalog.products.length < 1 || catalog.products.length > MAX_PRODUCTS) {
    throw httpError(400, 'catalog.json must list between 1 and 30 products')
  }

  const usedImages = new Set()
  const products = []
  for (let i = 0; i < catalog.products.length; i++) {
    const source = catalog.products[i]
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw httpError(400, 'Invalid product entry')
    }
    const descriptionValue = source.description === undefined || source.description === null ? '' : source.description
    const name = plainText(source.name, 128, false)
    const description = plainText(descriptionValue, 500, true)
    const price = money(source.price)
    const deluxePrice = source.deluxePrice === undefined ? price : money(source.deluxePrice)
    const imagePath = safeRelativePath(source.image)
    if (!name || description === null || price === null || deluxePrice === null || !imagePath) {
      throw httpError(400, 'Invalid product entry')
    }
    if (imagePath === 'catalog.json' || !files.has(imagePath) || usedImages.has(imagePath)) {
      throw httpError(400, 'Product image is missing from the archive')
    }
    const image = path.basename(imagePath)
    if (!image || image !== imagePath.split('/').pop()) {
      throw httpError(400, 'Invalid product entry')
    }
    usedImages.add(imagePath)
    products.push({ name, description, price, deluxePrice, image })
  }
  return products
}

async function createImportDirectory (importId) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true })
  const uploadsRoot = fs.realpathSync(UPLOADS_ROOT)
  if (!isInside(UPLOADS_ROOT, uploadsRoot)) {
    throw httpError(500, 'Upload directory is unavailable')
  }
  const importRoot = path.resolve(uploadsRoot, importId)
  if (!isInside(uploadsRoot, importRoot)) {
    throw httpError(400, 'Invalid import path')
  }
  fs.mkdirSync(importRoot, { recursive: true })
  const realImport = fs.realpathSync(importRoot)
  if (!isInside(uploadsRoot, realImport)) {
    throw httpError(400, 'Invalid import path')
  }
  return realImport
}

function writeExtractedFiles (importRoot, files) {
  files.forEach((data, relative) => {
    const segments = relative.split('/')
    const destination = path.resolve(importRoot, ...segments)
    if (!isInside(importRoot, destination)) {
      throw httpError(400, 'Archive contains an invalid path')
    }
    const parent = path.dirname(destination)
    fs.mkdirSync(parent, { recursive: true })
    const realParent = fs.realpathSync(parent)
    if (!isInside(importRoot, realParent)) {
      throw httpError(400, 'Archive contains an invalid path')
    }
    const finalPath = path.join(realParent, path.basename(destination))
    if (!isInside(importRoot, finalPath)) {
      throw httpError(400, 'Archive contains an invalid path')
    }
    writeNewFile(finalPath, data)
  })
}

function writeNewFile (finalPath, data) {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
  const handle = fs.openSync(finalPath, flags, 0o644)
  try {
    fs.writeSync(handle, data)
  } finally {
    fs.closeSync(handle)
  }
}

function readCapped (entry, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0
    let settled = false
    const chunks = []
    const fail = (error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }
    let stream
    try {
      stream = entry.stream()
    } catch (err) {
      fail(httpError(400, 'Invalid zip archive'))
      return
    }
    stream.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        if (typeof stream.destroy === 'function') {
          stream.destroy()
        }
        fail(httpError(400, 'Archive entry is too large'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => fail(httpError(400, 'Invalid zip archive')))
    stream.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      resolve(Buffer.concat(chunks, total))
    })
  })
}

function userFromRequest (req) {
  const cookieToken = req.cookies && req.cookies.token
  const fromCookie = insecurity.authenticatedUsers.get(cookieToken)
  if (fromCookie) {
    return fromCookie
  }
  return insecurity.authenticatedUsers.from(req)
}

function isZipUpload (file) {
  const original = typeof file.originalname === 'string' ? file.originalname : ''
  if (path.extname(original).toLowerCase() !== '.zip') {
    return false
  }
  const buffer = file.buffer
  return buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
}

function declaredEntryCount (buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const index = buffer.lastIndexOf(signature)
  if (index < 0 || index + 22 > buffer.length) {
    return null
  }
  return buffer.readUInt16LE(index + 10)
}

function isDirectoryEntry (entry) {
  if (typeof entry.path === 'string' && (entry.path.endsWith('/') || entry.path.endsWith('\\'))) {
    return true
  }
  return unixFileType(entry) === 0x4000
}

function isLinkEntry (entry) {
  return unixFileType(entry) === 0xA000
}

function unixFileType (entry) {
  const attributes = entry.externalFileAttributes || 0
  return (attributes >>> 16) & 0xF000
}

function isEncrypted (entry) {
  return Boolean(entry.flags & 0x1)
}

function isSupportedCompression (entry) {
  return entry.compressionMethod === 0 || entry.compressionMethod === 8
}

function safeRelativePath (entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0 || entryPath.length > 255) {
    return null
  }
  if (entryPath.indexOf('\0') !== -1 || entryPath.indexOf('%00') !== -1) {
    return null
  }
  if (path.posix.isAbsolute(entryPath) || path.win32.isAbsolute(entryPath)) {
    return null
  }
  const rawSegments = entryPath.split(/[/\\]/)
  const safeSegments = []
  for (let i = 0; i < rawSegments.length; i++) {
    const segment = rawSegments[i]
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      return null
    }
    const sanitized = insecurity.sanitizeFilename(segment)
    if (!sanitized || sanitized !== segment || sanitized === '.' || sanitized === '..') {
      return null
    }
    if (sanitized.length > 100) {
      return null
    }
    safeSegments.push(sanitized)
  }
  if (safeSegments.length === 0 || safeSegments.length > MAX_PATH_SEGMENTS) {
    return null
  }
  return safeSegments.join('/')
}

function isInside (root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  return relative !== '' &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep).indexOf('..') === -1 &&
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
}

function plainText (value, max, allowEmpty) {
  if (typeof value !== 'string') {
    return null
  }
  if (/[\u0000-\u001F\u007F<>]/.test(value)) {
    return null
  }
  const trimmed = value.trim()
  if ((trimmed.length === 0 && !allowEmpty) || trimmed.length > max) {
    return null
  }
  if (insecurity.sanitizeSecure(trimmed) !== trimmed) {
    return null
  }
  return trimmed
}

function money (value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 99999.99) {
    return null
  }
  return Math.round(value * 100) / 100
}

function hasImageMagic (buffer, ext) {
  if (ext === '.png') {
    return buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }
  if (ext === '.gif') {
    if (buffer.length < 6) {
      return false
    }
    const header = buffer.slice(0, 6).toString('ascii')
    return header === 'GIF89a' || header === 'GIF87a'
  }
  if (ext === '.webp') {
    return buffer.length >= 12 &&
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

function removeTree (root, target) {
  if (!target || !isInside(root, target)) {
    return
  }
  if (!fs.existsSync(target)) {
    return
  }
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(target)
    return
  }
  const names = fs.readdirSync(target)
  for (let i = 0; i < names.length; i++) {
    removeTree(root, path.join(target, names[i]))
  }
  fs.rmdirSync(target)
}

function httpError (statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
