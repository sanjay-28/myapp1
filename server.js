const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

const db = mysql.createConnection({
    host: '11.11.0.2',
    user: 'fashionuser',
    password: 'Password@123',
    database: 'fashiondb'
});

db.connect((err)=>{
    if(err){
        console.log(err);
    } else {
        console.log('MySQL Connected');
    }
});

app.use(express.static('public'));

app.get('/products', (req,res)=>{

    db.query('SELECT * FROM products', (err,result)=>{

        if(err){
            res.send(err);
        } else {
            res.json(result);
        }

    });

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, ()=>{
    console.log(`Server running on ${PORT}`);
});
