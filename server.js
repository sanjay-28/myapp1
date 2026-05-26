const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

/*
MYSQL POOL
BEST FOR CLOUD RUN
*/

const db = mysql.createPool({

    host: '11.11.0.2',
    user: 'fashionuser',
    password: 'Password@123',
    database: 'fashiondb',

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0

});

/*
TEST ROUTE
*/

app.get('/health', (req, res) => {
    res.send('Server Healthy');
});

/*
PRODUCTS API
*/

app.get('/api/products', (req, res) => {

    db.query('SELECT * FROM products', (err, result) => {

        if (err) {

            console.log(err);

            return res.status(500).json({
                error: err.message
            });

        }

        res.json(result);

    });

});

/*
START SERVER
*/

app.listen(PORT, '0.0.0.0', () => {

    console.log(`Server running on port ${PORT}`);

});
<script>

fetch('/api/products')
.then(res => res.json())
.then(data => {

    let output = '';

    data.forEach(product => {

        output += `

        <div class="card">

            <img src="${product.image}">

            <div class="card-content">

                <h2>${product.name}</h2>

                <p>${product.description}</p>

                <div class="price">₹${product.price}</div>

                <button>Add to Cart</button>

            </div>

        </div>

        `;

    });

    document.getElementById('products').innerHTML = output;

});

</script>
