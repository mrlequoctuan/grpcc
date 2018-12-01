'use strict';

require('colors');
require('events').prototype.inspect = () => {return 'EventEmitter {}';};

let fs = require('fs');
let net = require('net');
let grpc = require('grpc');
let fmt = require('util').format;
let repl = require('repl');
let inquirer = require('inquirer');
let vm = require('vm');

var protoLoader = require('@grpc/proto-loader');
var Protobuf = require("protobufjs");
var _ = require("protobufjs/ext/descriptor");

// dirty patch to support load .pb file
// TODO support array filename
let _loadSync = Protobuf.Root.prototype.loadSync;
Protobuf.Root.prototype.loadSync = function(filename, options) {
  var root;
  if (filename.endsWith(".pb")) {
    root = Protobuf.Root.fromDescriptor(fs.readFileSync(filename));
    Object.assign(this, root); // TODO find a better way?
  } else {
    root = _loadSync.call(this, filename, options);
  }
  return this;
};

function createUnixSocketProxy(unixAddr, cb) {
  let server = net.createServer((conn) => {
    let unixConn = net.createConnection(unixAddr);
    unixConn.on('error', () => { conn.end(); });
    conn.pipe(unixConn);
    unixConn.pipe(conn);

    conn.unref();
    unixConn.unref();
  });
  server.listen(0, "localhost", () => {
    server.unref();
    let port = server.address().port;
    console.log('Proxying UNIX socket', unixAddr, 'via port', port);
    cb(null, port);
  });
}

function prepareClient(defaultService, services, args, options) {
  if (args.address.startsWith('unix:')) {
    createUnixSocketProxy(args.address.substr(5), (err, tcpPort) => {
      if (err) return console.error('Unable to prepare proxy:', err);

      args.address = 'localhost:' + tcpPort;
      init(defaultService, services, args, options);
    });
    return;
  }

  init(defaultService, services, args, options);
}

function createClient(args, options) {
  if (!args.address) {
    throw new Error("Address should be valid");
  }

  if (typeof args.proto === 'string') {
    args.proto = [args.proto];
  }

  let loadOptions = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  };

  let pkgDef = {}
  for (var i = args.proto.length - 1; i >= 0; i--) {
    let tmp = protoLoader.loadSync(args.proto[i], loadOptions);
    Object.assign(pkgDef, tmp);
  }
  let parsed = grpc.loadPackageDefinition(pkgDef);

  // It's possible the proto has no `package defined`
  let unknowns = {};
  Object.keys(parsed).forEach(k => {
    if (parsed[k].service) {
      unknowns[k] = parsed[k];
      delete parsed[k];
    }
  })
  parsed['unknown'] = unknowns;

  let services = [];
  findService(parsed).forEach(def => {
    let desc = {}
    desc.package = def.package;
    desc.name = def.serviceName;
    desc.fqn = `${desc.package}.${desc.name}`;
    desc.def = def.def;
    services.push(desc);

    desc.def.prototype.usage = function() {
      console.log(`%s.%s usage:`, desc.package.yellow, desc.name.yellow.bold);
      let s = desc.def.service;
      let empty = Buffer.from([]);

      Object.keys(s).map(name => {
        let reqKeys = Object.keys(s[name].requestDeserialize(empty));
        console.log('  %s ({%s})', s[name].originalName.green.padEnd(36), reqKeys.join().grey);
      });
      console.log();
    }
  });

  if (services.length === 0) {
    console.error('Unable to find any service in proto file');
  } else if (services.length === 1) {
    return prepareClient(services[0].fqn, services, args, options);
  } else if (args.manual) {
    return prepareClient(null, services, args, options);
  } else {
    var filteredServices = services;
    // only use args.service when have many services to choice from
    if (args.service) {
      let matcher = new RegExp(args.service, 'i');
      filteredServices = services.filter(s => matcher.test(s.name) || matcher.test(s.fqn))
      if (filteredServices.length === 0) {
        throw 'service arg not match any services';
      } else if (filteredServices.length === 1) {
        return prepareClient(filteredServices[0].fqn, services, args, options);
      }
    }

    inquirer.prompt([{
      type: 'list',
      name: 'service',
      message: 'What service would you like to connect to?',
      choices: filteredServices.map(s => s.fqn),
    }]).then(function(answers) {
      prepareClient(answers.service, services, args, options);
    }).catch(err => {
        console.error(err);
    });
  }
}

// Recursively search a parsed protos definition for the first service
function findService(def, n){
  let keys = Object.keys(def);
  let found = [];
  let m = n || 0;

  if (m > 5) return [];

  for(let i=0; i < keys.length; i++){
    let propName = keys[i]
    let propValue = def[propName];

    if(typeof propValue === 'object'){
      findService(propValue, m++).forEach(res => {
        res.package = `${propName}${res.package ? '.' + res.package : ''}`;
        found.push(res);
      });
    } else if(propValue.service){
      found.push({serviceName: propName, def: propValue});
    }
  }

  return found;
}

function init(defaultService, services, args, defaultOptions) {
  let defaultAddr = args.address;
  let ev = loadEval(args);
  let defaultCreds = createCredentials(defaultOptions);

  function createGrpcClient(serviceName, address, options) {
    if (!serviceName || typeof serviceName !== 'string') {
      throw "first argument must be service name";
    }

    let creds = defaultCreds;
    if (options) {
      creds = createCredentials(options);
    }

    let service = services.find(s => s.fqn === serviceName);
    if (!service) {
      throw `no service name match "${serviceName}"`;
    }
    return new service.def(address || defaultAddr, creds);
  }

  let availableServices = [];
  services.forEach(s => {
    availableServices.push(s.fqn);
  });

  function loadVars(table, displayPrompt, newLine) {
    table.grpc = grpc;
    table.Client = createGrpcClient;
    if (!args.manual)
      table.client = createGrpcClient(defaultService);
    table.printReply = printReply.bind(null, displayPrompt, newLine);
    table.pr = table.printReply;
    table.streamReply = streamReply.bind(null, displayPrompt, newLine);
    table.sr = table.streamReply;
    table.createMetadata = createMetadata;
    table.cm = createMetadata;
    table.printMetadata = printMetadata.bind(null, displayPrompt, newLine);
    table.pm = table.printMetadata;
    table.availableServices = availableServices;
  }

  if (ev && ev.length > 0) {
    loadVars(global, ()=>{}, ()=>{});
    vm.runInThisContext(ev, {
      displayErrors: true,
      filename: args.exec || "eval-arg",
    });

  } else {
    let prompt = "grpcc> ".green;
    if (!args.manual) {
      let service = services.find(s => s.fqn === defaultService);
      printUsage(service.package, service.name, defaultAddr, service.def.service);
      console.log("");
      prompt = getPrompt(service.name, defaultAddr)
    }

    let replOpts = {
      prompt: prompt,
      ignoreUndefined: true,
      replMode: repl.REPL_MODE_SLOPPY,
      useGlobal: true,
    };
    let rs = repl.start(replOpts);
    loadVars(rs.context, rs.displayPrompt.bind(rs), console.log);
    rs.on('exit', () => {
      console.log();
    });
    if (process.env.GRPCC_HISTORY === undefined || process.env.GRPCC_HISTORY !== '') {
      let grpcc_history = process.env.GRPCC_HISTORY || process.env.HOME + '/.grpcc_history';
      require('repl.history')(rs, grpcc_history);
    }
  }
}

function loadEval(args) {
  if (args.eval) {
    return args.eval;
  } else if (args.exec) {
    return fs.readFileSync(args.exec);
  } else {
    return undefined;
  }
}

function createCredentials(options) {
  if (options.insecure) {
    return grpc.credentials.createInsecure();
  }

  if (!options.rootCert) {
    return grpc.credentials.createSsl();
  }

  let rootCert = undefined;
  let privateKey = undefined;
  let certChain = undefined;

  try {
    if (options.rootCert) {
      rootCert = fs.readFileSync(options.rootCert);
    }

    if (options.privateKey) {
      privateKey = fs.readFileSync(options.privateKey);
    }

    if (options.certChain) {
      certChain = fs.readFileSync(options.certChain);
    }

  } catch(e) {
    console.error('Unable to load custom SSL certs: ' + e);
    process.exit(1);
  }

  return grpc.credentials.createSsl(rootCert, privateKey, certChain);
}

function createMetadata(metadata) {
  if (metadata instanceof grpc.Metadata) {
    return metadata
  }

  var meta = new grpc.Metadata();
  for(var k in metadata){
    var v = metadata[k];
    if(typeof v !== 'string'){
      v = v.toString();
    }
    meta.add(k, v);
  }
  return meta;
}

function printUsage(pkg, serviceName, address, service) {
  console.log("Available globals:");

  function printCmd(cmd, desc, alias) {
    if (alias) {
      alias = ` (alias: ${alias.red})`;
    } else {
      alias = ''
    }
    console.log('  %s %s%s', cmd.red.padEnd(30), desc, alias);
  }

  printCmd('availableServices', `loaded service names - for used by ${'Client()'.yellow} below`);
  printCmd('Client()', "function to create new grpc client");

  console.log()
  printCmd('printReply()', 'function to easily print a unary call reply', 'pr');
  printCmd('streamReply()', 'function to easily print stream call replies', 'sr');
  printCmd('createMetadata()', 'convert JS objects into grpc metadata instances', 'cm');
  printCmd('printMetadata()', "function to easily print a unary call's metadata", 'pm');

  console.log()

  printCmd('client', `grpc client for ${pkg.yellow}.${serviceName.yellow.bold} (address: ${address.green})`)
  printCmd('  .usage()', 'show client usage')

}

function getPrompt(serviceName, address) {
  return serviceName.blue + '@' + address + '> ';
}

function printReply(displayPrompt, newLine, err, reply) {
  newLine();
  if (err) {
    if (err.metadata) {
      err.metadata = err.metadata.getMap();
    }

    console.log("Error:".red, err);
    displayPrompt();
  } else {
    console.log(JSON.stringify(reply, false, '  '));
    displayPrompt();
  }
}

function printMetadata(displayPrompt, newLine, metadata) {
  newLine();
  let obj = {
    Metadata: metadata.getMap()
  }
  console.log(JSON.stringify(obj, false, '  '));
  displayPrompt();
}

function streamReply(displayPrompt, newLine, reply) {
  newLine();
  console.log(JSON.stringify(reply, false, '  '));
  displayPrompt();
}

module.exports = createClient;
