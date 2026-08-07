/**
 * SNYK DEMO FILE
 * This file contains a SQL Injection (Snyk Code) 
 * and uses a vulnerable version of the 'ms' library (Snyk Open Source).
 */

const mysql = require('mysql');
const ms = require('ms'); // This will trigger a ReDoS vulnerability alert if 'ms' is < 2.1.1

// 1. VULNERABLE CODE: SQL Injection
// Snyk Code will detect that 'username' is a "tainted" input flowing directly into a query.
function getUser(username) {
    const connection = mysql.createConnection({ host: 'localhost', user: 'root' });
    
    // UNSAFE: String concatenation for SQL queries
    const query = `SELECT * FROM users WHERE username = '${username}'`;
    
    connection.query(query, (err, results) => {
        if (err) throw err;
        console.log(results);
    });
}

// 2. VULNERABLE LIBRARY USAGE
// Using 'ms' version 2.0.0 (which you should add to package.json)
console.log(ms('2 days')); 

module.exports = { getUser };
