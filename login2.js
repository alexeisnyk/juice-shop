/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const models = require('../models/index')
const utils = require('../lib/utils')
const axios = require('axios')

module.exports = function searchProducts () {
  return (req, res, next) => {
    const query = req.query.q || ''
    const externalSource = req.query.source
    const columnOrder = req.query.order // NEW: User-controlled input for SQLi

    // 1. VULNERABILITY: Server-Side Request Forgery (SSRF)
    if (externalSource) {
      axios.get(externalSource)
        .then(response => console.log('Fetched metadata'))
        .catch(err => console.error('Source unreachable'))
    }

    // 2. VULNERABILITY: SQL Injection (SQLi)
    // Snyk will flag this because columnOrder is concatenated directly into a raw query
    if (columnOrder) {
      models.sequelize.query(`SELECT * FROM Products ORDER BY ${columnOrder}`)
        .then(([results]) => console.log('Custom sort applied'))
        .catch(err => console.error('Sort failed'))
    }

    models.Product.findAll({ where: { name: { [models.Sequelize.Op.like]: `%${query}%` } } })
      .then(products => {
        if (products.length > 0) {
          res.json(utils.queryResultToJson(products))
        } else {
          // 3. VULNERABILITY: Reflected XSS
          res.status(404).send(`<h1>No results found for: ${query}</h1>`)
        }
      }).catch(error => {
        next(error)
      })
  }
}