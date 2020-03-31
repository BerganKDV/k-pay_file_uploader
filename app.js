const express = require('express');
const multer = require('multer');
const axios = require('axios');
const auth = require('basic-auth');
const fs = require('fs');
const tempFolder = process.env.NODE_ENV === 'Production' ? '/tmp' : './tmp';
const upload = multer({ dest: tempFolder });
const { promisify } = require('util');
fs.readFileAsync = promisify(fs.readFile);
const progressStorage = {};

const app = express();

// Add basic authentication
// const username = process.env.USERNAME;
// const password = process.env.PASSWORD;
// app.use((req, res, next) => {
//   let user = auth(req)

//   if (user === undefined || user['name'] !== username || user['pass'] !== password) {
//     res.statusCode = 401
//     res.setHeader('WWW-Authenticate', 'Basic realm="Node"')
//     res.end('Incorrect username or password.')
//   } else {
//     next();
//   }
// });


app.use(express.static(__dirname + '/public'));

app.get('/', (req, res) => {
  consoe.log('Why is this not using the middleware?');
  res.sendFile(__dirname + '/public/index.html');
});

// Process form data
const fields = [
  { name: 'files-to-upload', maxCount: 1000 },
  { name: 'mapping-file-to-upload', maxCount: 1 }
];
app.post('/upload', upload.fields(fields), function (req, res) {

  function increaseProgress() {
    progressStorage[hash].filesProcessed += 1;
    const percentComplete = Math.round((progressStorage[hash].filesProcessed / progressStorage[hash].totalFiles) * 1000) / 10;
    progressStorage[hash].percentComplete = percentComplete;
    // console.log('Progress', progressStorage[hash]);
  }

  // Upload to K-Pay helper func
  async function uploadToKpay(config, tokenObj) {
    console.log('Config', config);
    const { company, type, file, rec_id, document_type, description, employee_photo } = config;

    function wait(x) {
      return new Promise(resolve => setTimeout(resolve, x));
    }

    try {
      let linked_id = rec_id ? rec_id : file.originalname.substring(0, file.originalname.lastIndexOf('.'));
      const docObj = {
        file_name: file.originalname,
        display_name: file.originalname,
        type,
        linked_id
      }
      if (document_type) docObj.document_type = { id: document_type };
      if (description) docObj.description = description;
      const config = {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authentication': `Bearer ${tokenObj.token}`,
        }
      }

      // If it's an employee photo just upload the photo
      if (employee_photo && employee_photo.toLowerCase() === 'yes') {
        const docRes = await axios.get(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/employees/${linked_id}`, config);
        if (docRes.status !== 200) {
          throw docRes.body;
        }
        // console.log('Document Response', docRes.data);

        const ticketUrl = docRes.data.photo_href;
        const buffer = await fs.readFileAsync(file.path);
        const uploadRes = await axios.post(ticketUrl, buffer, { headers: { 'Content-Type': file.mimetype } });
        console.log('Upload Response', uploadRes.status);
        console.log('Upload headers', uploadRes.headers);

        // Otherwise upload to the document storage
      } else {
        console.log('Doc Object', docObj);
        const docRes = await axios.post(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/ids`, docObj, config);
        console.log('Document Response', docRes.headers.location);
        console.log('Document Response headers', docRes.headers);
        if (docRes.status !== 201) {
          console.log('Error Body', docRes.body);
          throw docRes.body;
        }

        const location = docRes.headers.location;
        const ticketRes = await axios.get(location, config);
        // console.log('Ticket Response', ticketRes.data);
        if (ticketRes.status !== 200) {
          throw file.originalname
        }

        const ticketUrl = ticketRes.data._links.content_rw;
        const buffer = await fs.readFileAsync(file.path);
        const uploadRes = await axios.post(ticketUrl, buffer, { headers: { 'Content-Type': file.mimetype } });
        console.log('Upload Response', uploadRes.status);
        console.log('Upload headers', uploadRes.headers);
      }

      // Cleanup file
      fs.unlink(file.path, (err) => {
        if (err) throw err;
      });

      // Increase the progress
      increaseProgress();

      // Wait so you don't hit usage limits
      await wait(1000);

    } catch (err) {
      console.error('Error', err);
      increaseProgress();
      progressStorage[hash].errors.push({
        file: file.originalname,
        message: 'Bad File Data for file'
      });

      // Cleanup file
      fs.unlink(file.path, (err) => {
        if (err) throw err;
      });
      await wait(3800);
    }
  }

  // Convert CSV To Object Helper Func
  function csvToObj(csv) {
    csv = csv.replace(/\r/g, '');
    csv = csv.replace(/^\uFEFF/, '');
    const lines = csv.split('\n');
    const result = [];
    const headers = lines[0].split(',');

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

  // Create unique hash helper function
  function generateHash() {
    function s4() {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
  }

  // Asyncronously process files
  async function processFiles() {
    let mappingObj = [];
    try {
      if (mappingFiles && mappingFiles.length !== 0) {
        const csvTextFile = await fs.readFileAsync(mappingFiles[0].path, 'utf8');
        // console.log('CSV Text File', csvTextFile);
        mappingObj = csvToObj(csvTextFile);
        console.log('Mapping', mappingObj);

        // Cleanup mapping file
        fs.unlink(mappingFiles[0].path, (err) => {
          if (err) throw err;
        });
      }

      const credentials = {
        credentials: { username: req.body.username, password: req.body.password, company: req.body.company }
      }
      const config = {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Api-Key': req.body.api_key
        }
      };
      const tokenRes = await axios.post('https://secure.saashr.com/ta/rest/v1/login', credentials, config);
      console.log('Token Response', tokenRes.data);
      const tokenObj = tokenRes.data;
      const docTypeMap = await lookupDocTypes(tokenObj.token, req.body.company);


      // Create the array of configs
      const configs = [];
      let files = req.files['files-to-upload'];
      progressStorage[hash] = {
        totalFiles: files.length,
        filesProcessed: 0,
        percentComplete: 0,
        errors: []
      }
      console.log('Files', files);
      for (const fileObj of files) {
        let rowIndex = mappingObj.map(rec => rec.file_name).indexOf(fileObj.originalname);
        if (rowIndex === -1) {
          const filenameWithoutExtension = fileObj.originalname.substring(0, fileObj.originalname.lastIndexOf('.'));
          rowIndex = mappingObj.map(rec => rec.file_name).indexOf(filenameWithoutExtension);
        }
        if (rowIndex >= 0) {
          const rec_id = mappingObj[rowIndex].system_id;
          const documentName = mappingObj[rowIndex].document_type_name;
          const document_type = docTypeMap[documentName];
          const description = mappingObj[rowIndex].description;
          const employee_photo = mappingObj[rowIndex].employee_photo;

          configs.push({
            company: req.body.company,
            type: req.body.document_type,
            rec_id,
            document_type,
            description,
            employee_photo,
            file: fileObj
          });
        } else {
          console.error(`"${fileObj.originalname}" has no match in the mapping file.`);
          progressStorage[hash].errors.push({ message: `"${fileObj.originalname}" has no match in the mapping file.` });
          increaseProgress();
        }
      }

      if (configs.length === 0) {
        console.error('No files match between mapping file and selected files');
        progressStorage[hash].errors.push({
          message: 'No files match between mapping file and selected files'
        })
      }

      // const uploadPromiseGenerator = (i: number): Promise<void> => {
      //   return new Promise(async (resolve, reject) => {
      //     const key = EHKeys[i];
      //     const employee = groupedEH[key];
      //     try {
      //       // console.log('EINs', this.eins);
      //       // console.log('File EIN', employee[0].EIN);
      //       const einObj = this.eins[employee[0].EIN];
      //       const nameObj = { first: employee[0]['First Name'], last: employee[0]['Last Name'] };
      //       let kpayId = await this.lookupEmployeeId(employee[0].SSN, 'ssn', einObj, nameObj, employee[0]['Store - CC1'], 'EH');
      //       if (!kpayId) {
      //         kpayId = await this.retryEmployeeLookup(employee[0].SSN, 'ssn', einObj, nameObj, employee[0]['Store - CC1'], 'EH', 'upload pay statement for employee');
      //       }
      //       console.log('KPay ID', kpayId);
      //       if (kpayId && batches) {
      //         await this.uploadPayStatements(kpayId, employee, batches, payrollList, payrollEndDate);
      //       } else {
      //         this.jobStats.EH.failed++;
      //       }
      //     } catch (err) {
      //       console.error('There was a problem uploading EH files', err);
      //       this.log('EH', 'critical', 'There was a problem uploading EH files', err.toString());
      //     }
      //     this.jobState.EH.progress.processed++;
      //     if ((i !== 0 && i % Math.round(EHKeys.length / 7.5) === 0) || i === EHKeys.length - 1) {
      //       this.updateProgress('EH');
      //     }
      //     resolve();
      //   });
      // };

      let uploadPromiseArr = [];
      for (let i = 0; i < configs.length; i++) {

        if (Date.now() >= (tokenObj.expiration - 60000)) {
          console.log('Refreshing token');
          const tokenRes = await axios.post('https://secure.saashr.com/ta/rest/v1/login', credentials, config);
          console.log('Token Response', tokenRes.data);
          tokenObj = tokenRes.data;
        }

        // uploadPromiseArr.push(uploadPromiseGenerator(i));
        uploadPromiseArr.push(uploadToKpay(configs[i], tokenObj));

        if ((i !== 0 && i % 1 === 0) || i === configs.length - 1) { // Can't go higher than one otherwise you get anomolies
          await Promise.all(uploadPromiseArr);
          uploadPromiseArr = [];
        }
      }

      // for (const config of configs) {
      //   if (Date.now() >= (tokenObj.expiration - 60000)) {
      //     console.log('Refreshing token');
      //     const tokenRes = await axios.post('https://secure.saashr.com/ta/rest/v1/login', credentials, config);
      //     console.log('Token Response', tokenRes.data);
      //     tokenObj = tokenRes.data;
      //   }
      //   await uploadToKpay(config, tokenObj);
      // }
    } catch (err) {
      console.log('Error', err);
    }
  }

  async function lookupDocTypes(token, company) {
    const config = {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authentication': `Bearer ${token}`,
      }
    }
    const docRes = await axios.get(`https://secure.saashr.com/ta/rest/v2/companies/|${company}/lookup/document-types`, config);
    if (docRes.status !== 200) {
      throw docRes.body;
    }
    console.log('Doc Type Response', docRes.data);
    const docTypeArr = docRes.data.items;
    const docTypeMap = docTypeArr.reduce(function (acc, docType) {
      acc[docType.display_name] = docType.id;
      return acc;
    }, {});
    return docTypeMap;
  }

  // ============================================ MAIN ==============================================

  console.log('File', req.files);
  console.log('Text', req.body);
  const mappingFiles = req.files['mapping-file-to-upload'];
  // console.log('Mapping File', mappingFiles);

  // Validate mapping file
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

  // Generate unique hash
  const hash = generateHash();
  console.log('Hash', hash);

  processFiles();

  res.send({ status: 'success', message: hash });
});

app.get('/progress', (req, res) => {
  const hash = req.query.hash;
  console.log('Progress', `Processed: ${progressStorage[hash].filesProcessed}, Total: ${progressStorage[hash].totalFiles}`);
  res.send(progressStorage[hash]);
});

app.listen(process.env.PORT || 3000);