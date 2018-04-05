const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
// const upload = multer({
//   dest: 'uploads/' // this saves your file into a directory called 'uploads'
// }); 
const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

const app = express();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// It's very crucial that the file name matches the name attribute in your html
app.post('/', upload.array('files-to-upload', 500), function (req, res) {
    console.log('File', req.files);
    console.log('Text', req.body);
    async function uploadToKpay(config) {
        console.log('Config', config);
        const { company, api_key, username, password, document_type, file } = config;
        try {
            const credentials = {
                credentials: { username, password, company }
            }
            const config = {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Api-Key': api_key
                }
            }
            const tokenRes = await axios.post('https://secure.saashr.com/ta/rest/v1/login', credentials, config);
            console.log('Token Response', tokenRes.data);
            const tokenObj = tokenRes.data;
            const linked_id = file.originalname.substring(0, file.originalname.lastIndexOf('.'));
            const docObj = {
                type: document_type,
                file_name: file.originalname,
                display_name: file.originalname,
                description: 'Test description.',
                linked_id
            }
            // console.log('Document Obj', docObj);
            delete config.headers['Api-Key'];
            config.headers['Authentication'] = `Bearer ${tokenObj.token}`;
            // console.log('Header config', config);
            const docRes = await axios.post(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/ids`, docObj, config);
            console.log('Document Response', docRes.headers);
            if (docRes.status !== 201)
                throw docRes.body;

            const location = docRes.headers.location;
            const ticketRes = await axios.get(location, config);
            console.log('Ticket Response', ticketRes.data);
            if (ticketRes.status !== 200)
                throw ticketRes.body;

            const ticketUrl = ticketRes.data._links.content_rw;
            const uploadRes = await axios.post(ticketUrl, file.buffer, { headers: { 'Content-Type': file.mimetype } });
            console.log('Upload Response', uploadRes.status);

        } catch (err) {
            console.error('Error', err);
        }
    }

    if (!req.file && !req.files) {
        res.end('No File Selected');
        return;
    }

    let files = req.files;
    if (!files) files = [req.file];
    
    files.forEach((fileObj) => {
        const config = {
            company: req.body.company,
            api_key: req.body.api_key,
            username: req.body.username,
            password: req.body.password,
            document_type: req.body.document_type,
            file: fileObj
        }
        uploadToKpay(config);
    });
    // const config = {
    //     company: req.body.company,
    //     api_key: req.body.api_key,
    //     username: req.body.username,
    //     password: req.body.password,
    //     document_type: req.body.document_type,
    //     file: req.files[0]
    // }
    // uploadToKpay(config);

    res.redirect('/');
});

app.listen(process.env.PORT || 3000);