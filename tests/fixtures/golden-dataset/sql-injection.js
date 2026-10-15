// Intentionally vulnerable fixture for the golden-dataset regression suite.
// DO NOT use this pattern in real code.

const express = require('express');
const db = require('./db');

const app = express();

app.get('/users/search', (req, res) => {
  const name = req.query.name;

  // VULNERABLE: user input concatenated directly into a SQL query (SQL injection)
  const query = "SELECT id, name, email FROM users WHERE name = '" + name + "'";

  db.query(query, (err, results) => {
    if (err) {
      // VULNERABLE: raw error (and stack trace) sent back to the client
      res.status(500).send(err.stack);
      return;
    }
    res.json(results);
  });
});

module.exports = app;
