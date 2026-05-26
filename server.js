const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

const db = mysql.createConnection({
    host: 'VM_INTERNAL_IP',
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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', (req,res)=>{

    db.query('SELECT * FROM products', (err,result)=>{

        if(err){
            res.status(500).json(err);
        } else {
            res.json(result);
        }

    });

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, ()=>{
    console.log(`Server running on ${PORT}`);
});
