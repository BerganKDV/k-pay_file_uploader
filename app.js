const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const tempFolder = process.env.NODE_ENV === 'Production' ? '/tmp' : './tmp';
const upload = multer({ dest: tempFolder });
const { promisify } = require('util');
fs.readFileAsync = promisify(fs.readFile);
const progressStorage = {};

const app = express();
app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Process form data
const fields = [
    { name: 'files-to-upload', maxCount: 1000 },
    { name: 'mapping-file-to-upload', maxCount: 1 }
];
app.post('/upload', upload.fields(fields), function (req, res) {

    // Upload to K-Pay helper func
    async function uploadToKpay(config) {
        console.log('Config', config);
        const { company, api_key, username, password, type, file, rec_id, document_type, description } = config;

        function increaseProgress() {
            progressStorage[hash].filesProcessed += 1;
            const percentComplete = Math.round((progressStorage[hash].filesProcessed / progressStorage[hash].totalFiles) * 1000) / 10;
            progressStorage[hash].percentComplete = percentComplete;
            console.log('Progress', progressStorage[hash]);
        }

        function wait(x) {
            return new Promise(resolve => setTimeout(resolve, x));
        }

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
            let linked_id = rec_id ? rec_id : file.originalname.substring(0, file.originalname.lastIndexOf('.'));
            const docObj = {
                file_name: file.originalname,
                display_name: file.originalname,
                type,
                linked_id
            }
            if (document_type) docObj.document_type = { id: document_type };
            if (description) docObj.description = description;
            delete config.headers['Api-Key'];
            config.headers['Authentication'] = `Bearer ${tokenObj.token}`;
            const docRes = await axios.post(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/ids`, docObj, config);
            // console.log('Document Response', docRes.headers.location);
            if (docRes.status !== 201) {
                throw docRes.body;
                return;
            }

            const location = docRes.headers.location;
            const ticketRes = await axios.get(location, config);
            // console.log('Ticket Response', ticketRes.data);
            if (ticketRes.status !== 200) {
                throw file.originalname
                return;
            }

            const ticketUrl = ticketRes.data._links.content_rw;
            const buffer = await fs.readFileAsync(file.path);
            const uploadRes = await axios.post(ticketUrl, buffer, { headers: { 'Content-Type': file.mimetype } });
            console.log('Upload Response', uploadRes.status);

            // Cleanup file
            fs.unlink(file.path, (err) => {
                if (err) throw err;
            });

            // Increase the progress
            increaseProgress();

            // Wait so you don't hit usage limits
            await wait(3800);

        } catch (err) {
            console.error('Error', err);
            increaseProgress();
            progressStorage[hash].errors.push({
                file: file.originalname,
                message: 'Bad File Data for file'
            })

            // Cleanup file
            fs.unlink(file.path, (err) => {
                if (err) throw err;
            });
            await wait(3800);
        }
    }

    // Convert To Object Helper Func
    function csvToObj(csv) {
        csv = csv.replace(/\r/g, '');
        csv = csv.replace(/^\uFEFF/, '');
        const lines = csv.split('\n');
        const result = [];
        const headers = lines[0].split(',');

        // Fix the weird character in front of text issue
        // let systemIdIndex = -1;
        // headers.forEach((header, i) => {
        //     if (header.indexOf('system_id') >= 0) systemIdIndex = i;
        // });
        // if (systemIdIndex >= 0) headers[systemIdIndex] = 'system_id';

        for (let i = 1; i < lines.length; i++) {
            const obj = {};
            const currentline = lines[i].split(',');
            for (var j = 0; j < headers.length; j++) {
                obj[headers[j]] = currentline[j];
            }
            result.push(obj);
        }
        return result;
    }

    // Create unique hash helper func
    function generateHash() {
        function s4() {
            return Math.floor((1 + Math.random()) * 0x10000)
                .toString(16)
                .substring(1);
        }
        return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
    }

    console.log('File', req.files);
    console.log('Text', req.body);
    const mappingFiles = req.files['mapping-file-to-upload'];
    // console.log('Mapping File', mappingFiles);

    // Validate mapping file
    // if (mappingFiles && mappingFiles[0].mimetype !== 'text/csv') {
    if (mappingFiles) {
        const mappingFileName = mappingFiles[0].originalname;
        const extension = mappingFileName.substr(mappingFileName.length - 4);
        console.log('Extension', extension);
        if (mappingFileName.substr(mappingFileName.length - 4) !== '.csv') {
            console.log('Incorrect File Type');
            res.send({
                status: 'failure',
                message: 'Incorrect mapping file type, must be a CSV file.'
            });
            return;
        }
    }

    // Validate files to upload
    if (!req.files['files-to-upload']) {
        console.log('No Files');
        res.send({
            status: 'failure',
            message: 'No File Selected'
        });
        return;
    }

    async function processFiles() {
        let mappingObj = [];
        try {
            if (mappingFiles && mappingFiles.length !== 0) {
                const csvTextFile = await fs.readFileAsync(mappingFiles[0].path, 'utf8');
                mappingObj = csvToObj(csvTextFile);
                // console.log('Mapping', mappingObj);

                // Cleanup mapping file
                fs.unlink(mappingFiles[0].path, (err) => {
                    if (err) throw err;
                });
            }

            // Create the array of configs
            const configs = [];
            let files = req.files['files-to-upload'];
            files.forEach((fileObj) => {
                const rowIndex = mappingObj.map(rec => rec.file_name).indexOf(fileObj.originalname);
                const rec_id = rowIndex >= 0 ? mappingObj[rowIndex].system_id : '';
                const document_type = rowIndex >= 0 && mappingObj[rowIndex].document_type_id ?
                    mappingObj[rowIndex].document_type_id :
                    '';
                const description = rowIndex >= 0 && mappingObj[rowIndex].description ?
                    mappingObj[rowIndex].description :
                    '';

                configs.push({
                    company: req.body.company,
                    api_key: req.body.api_key,
                    username: req.body.username,
                    password: req.body.password,
                    type: req.body.document_type,
                    rec_id,
                    document_type,
                    description,
                    file: fileObj
                });
            });

            progressStorage[hash] = {
                totalFiles: files.length,
                filesProcessed: 0,
                percentComplete: 0,
                errors: []
            }

            async function processArray(configs) {
                for (const config of configs) {
                    await uploadToKpay(config);
                }
            }
            processArray(configs);
        } catch (err) {
            console.log('Error', err);
        }
    }
    // Generate unique hash
    const hash = generateHash();
    console.log('Hash', hash);
    
    processFiles();

    res.send({ status: 'success', message: hash });
});

app.get('/progress', (req, res) => {
    const hash = req.query.hash;
    console.log('Hash', hash);
    const progressObj = progressStorage[hash] ? progressStorage[hash] : 0;

    console.log('Progress', progressStorage[hash]);
    res.send(progressStorage[hash]);
});

app.listen(process.env.PORT || 3000);