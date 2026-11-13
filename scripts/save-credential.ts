import {storeApiKey}from'../src/provider/index.js';
let secret='';for await(const chunk of process.stdin)secret+=chunk;await storeApiKey(secret.trim(),{explicitSetup:true});console.log('Credential stored in current-user vault.');
