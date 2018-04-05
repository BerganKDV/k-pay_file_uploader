const express = require('express');
const multer = require('multer');
const axios = require('axios');

// const upload = multer({
//   dest: 'uploads/' // this saves your file into a directory called 'uploads'
// }); 
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const progressStorage = {};

const app = express();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Process form data
app.post('/upload', upload.array('files-to-upload', 500), function (req, res) {
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
            // console.log('Token Response', tokenRes.data);
            const tokenObj = tokenRes.data;
            const linked_id = file.originalname.substring(0, file.originalname.lastIndexOf('.'));
            const docObj = {
                type: document_type,
                file_name: file.originalname,
                display_name: file.originalname,
                description: 'Test description.',
                linked_id
            }
            delete config.headers['Api-Key'];
            config.headers['Authentication'] = `Bearer ${tokenObj.token}`;
            const docRes = await axios.post(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/ids`, docObj, config);
            // console.log('Document Response', docRes.headers.location);
            if (docRes.status !== 201)
                throw docRes.body;

            const location = docRes.headers.location;
            const ticketRes = await axios.get(location, config);
            // console.log('Ticket Response', ticketRes.data);
            if (ticketRes.status !== 200)
                throw ticketRes.body;

            const ticketUrl = ticketRes.data._links.content_rw;
            const uploadRes = await axios.post(ticketUrl, file.buffer, { headers: { 'Content-Type': file.mimetype } });
            console.log('Upload Response', uploadRes.status);

            // Increase the progress
            const percentComplete = Math.round((progressStorage[hash].filesProcessed  / progressStorage[hash].totalFiles) * 1000) / 10;
            progressStorage[hash].filesProcessed += 1;
            progressStorage[hash].percentComplete = percentComplete;
            console.log('Progress', progressStorage[hash]);

            function wait(x) {
                return new Promise(resolve => setTimeout(resolve, x));
            }
            await wait(3800);

        } catch (err) {
            console.error('Error', err);
        }
    }

    if (req.files.length === 0) {
        console.log('No Files');
        res.send({ 
            status: 'failure',
            message: 'No File Selected'
        });
        return;
    }

    let files = req.files;

    // Create the array of configs
    const configs = [];
    files.forEach((fileObj) => {
        configs.push({
            company: req.body.company,
            api_key: req.body.api_key,
            username: req.body.username,
            password: req.body.password,
            document_type: req.body.document_type,
            file: fileObj
        });
    });

    // Create a unique hash for the job
    function generateHash() {
        function s4() {
            return Math.floor((1 + Math.random()) * 0x10000)
                .toString(16)
                .substring(1);
        }
        return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
    }
    const hash = generateHash();
    console.log('Hash', hash);
    progressStorage[hash] = {
        totalFiles: files.length,
        filesProcessed: 0,
        percentComplete: 0
    }
    console.log('Progress', progressStorage[hash]);

    async function processArray(configs) {
        for (const config of configs) {
            await uploadToKpay(config);
        }
    }
    processArray(configs);

    res.send({ 
        status: 'success', 
        message: hash 
    });
});

app.get('/progress', (req, res) => {
    const hash = req.query.hash;
    res.send(progressStorage[hash]);
});

app.listen(process.env.PORT || 3000);