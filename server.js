const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

const db = mysql.createConnection({
	#    host: ',
	host: '11.11.0.2'
    user: 'fashionuser',
    password: 'Password@123',
    database: 'fashiondb'
});

db.connect((err)=>{

    if(err){
        console.log('MySQL Connection Error');
        console.log(err);
    } else {
        console.log('MySQL Connected');
    }

});

app.get('/api/products', (req,res)=>{

    db.query('SELECT * FROM products', (err,result)=>{

        if(err){

            console.log(err);

            return res.status(500).json({
                error: 'Database query failed'
            });

        }

        res.json(result);

    });

});

app.get('/health', (req,res)=>{
    res.send('Server Healthy');
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', ()=>{

    console.log(`Server running on port ${PORT}`);

});
