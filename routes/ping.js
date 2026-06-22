/*
 * Copyright (c) 2014-2021 Bjoern Kimminich.
 * SPDX-License-Identifier: MIT
 */

const { exec } = require('child_process')

module.exports = function ping () {
  return (req, res) => {
    const host = req.query.host
    exec(`ping -c 1 ${host}`, (error, stdout, stderr) => {
      res.json({ output: stdout, error: stderr })
    })
  }
}
