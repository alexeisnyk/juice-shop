/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const fs = require('fs')
const path = require('path')
const RateLimit = require('express-rate-limit')
const insecurity = require('../lib/insecurity')

const UPLOADS_ROOT = path.resolve(__dirname, '../uploads')

const downloadLimiter = new RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  delayMs: 0,
  keyGenerator ({ ip }) { return ip || 'unknown' }
})

module.exports = function downloadUploadedFile () {
  return (req, res, next) => {
    downloadLimiter(req, res, (err) => {
      if (err) {
        next(err)
        return
      }
      sendUpload(req, res, next)
    })
  }
}

function sendUpload (req, res, next) {
  if (!userFromRequest(req)) {
    res.status(401)
    next(new Error('Blocked illegal activity by ' + remoteAddress(req)))
    return
  }

  const filename = req.query && req.query.filename
  if (!isPresentFilename(filename)) {
    res.status(400)
    next(new Error('Missing or invalid filename'))
    return
  }

  const safePath = safeUploadPath(filename)
  if (!safePath) {
    res.status(403)
    next(new Error('Invalid filename'))
    return
  }

  let stat
  try {
    stat = fs.lstatSync(safePath)
  } catch (err) {
    res.status(404)
    next(new Error('File not found'))
    return
  }

  if (!stat.isFile()) {
    res.status(404)
    next(new Error('File not found'))
    return
  }

  res.download(safePath, path.basename(safePath), (err) => {
    if (err) {
      next(err)
    }
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

function remoteAddress (req) {
  return (req.connection && req.connection.remoteAddress) || 'unknown'
}

function isPresentFilename (filename) {
  return typeof filename === 'string' &&
    filename.length > 0 &&
    filename.indexOf('\0') === -1 &&
    filename.indexOf('%00') === -1
}

function safeUploadPath (filename) {
  if (typeof filename !== 'string') {
    return null
  }
  const segments = filename.split(/[/\\]/)
  const safeSegments = []
  for (let i = 0; i < segments.length; i++) {
    const sanitized = insecurity.sanitizeFilename(segments[i])
    const base = path.basename(sanitized)
    if (!base || base === '.' || base === '..' || base !== sanitized) {
      return null
    }
    safeSegments.push(base)
  }
  if (safeSegments.length === 0) {
    return null
  }
  const candidate = path.resolve(UPLOADS_ROOT, safeSegments.join(path.sep))
  const relative = path.relative(UPLOADS_ROOT, candidate)
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep).indexOf('..') !== -1) {
    return null
  }
  return candidate
}
