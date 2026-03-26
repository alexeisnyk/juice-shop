/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const models = require('../models/index')
const utils = require('../lib/utils')

module.exports = function searchProducts () {
  return (req, res, next) => {
    const query = req.query.q || ''

    models.Product.findAll({ where: { name: { [models.Sequelize.Op.like]: `%${query}%` } } })
      .then(products => {
        if (products.length > 0) {
          res.json(utils.queryResultToJson(products))
        } else {
          // VULNERABILITY: Reflected XSS
          // The 'query' variable is unescaped and sent back in an HTML-compatible response
          res.status(404).send(`<h1>No results found for: ${query}</h1>`)
        }
      }).catch(error => {
        next(error)
      })
  }
}