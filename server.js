const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;

/*
START SERVER FIRST
IMPORTANT FOR CLOUD RUN
*/

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

/*
MYSQL CONNECTION
*/

const db = mysql.createConnection({
    host: '11.11.0.2',
    user: 'fashionuser',
    password: 'Password@123',
    database: 'fashiondb',
    connectTimeout: 10000
});

db.connect((err) => {

    if (err) {

        console.log('MYSQL CONNECTION FAILED');
        console.log(err);

    } else {

        console.log('MYSQL CONNECTED');

    }

});

/*
API
*/

app.get('/api/products', (req, res) => {

    db.query('SELECT * FROM products', (err, result) => {

        if (err) {

            console.log(err);

            return res.status(500).json({
                error: 'Database query failed'
            });

        }

        res.json(result);

    });

});

/*
HEALTH CHECK
*/

app.get('/health', (req, res) => {
    res.send('Server Healthy');
});
