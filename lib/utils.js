let assert = require('assert');
let fs = require('q-io/fs');
let path = require('path');
let bower = require('bower');
let tar = require('tar-fs');
let gunzip = require('gunzip-maybe');
let request = require('request');
let globby = require('globby');
let cheerio = require('cheerio');
let hydrolysis = require('hydrolysis');
let bep = require('bower-endpoint-parser');
let Q = require('q');
Q.longStackSupport = true;


/**
 * Comments in different files (particles.html) refer to this function
 * update them if there are any changes made here.
 * So basically we want to remove the bower_components folder but keep
 * some files in it so we first copy the files, then remove the bower_components
 * folder and then copy those files back by creating the directory trees
 * @param {Function} log The logger
 */
let removeBowerComponents = Q.async(function* (log) {
  let name = path.basename.bind(path), dir = path.dirname.bind(path);
  let resolve = path.resolve.bind(path), join = path.join.bind(path);
  let rel = p => `_site/${p}`;
  let pAll = (arr, fn) => Promise.all(arr.map(fn));

  let excludes = [
    'iframe-resizer/js/iframeResizer.contentWindow.min.js',
    'webcomponentsjs/webcomponents-lite.js',
    'particles.js/particles.js',
    't-component-panel/demo/property.json',
    't-component-panel/ace-element/ace/ace.js',
    't-component-panel/ace-element/ace/mode-json.js',
    't-component-panel/ace-element/ace/mode-javascript.js',
    't-component-panel/ace-element/ace/worker-json.js',
    't-component-panel/ace-element/ace/worker-javascript.js'
  ];

  excludes = excludes.map(e => resolve(rel(`bower_components/${e}`)));

  yield pAll(excludes, e => fs.copy(e, rel(name(e))));

  try {
    yield fs.removeTree(rel('bower_components'));
  } catch (err) {
    // FIXME: For some reason removing the bower_components fails
    // now since doing it is not so critical and since such errors
    // are a pure nonsense just catch it for now.
    log(err.toString());
  }

  yield pAll(excludes, e => fs.makeTree(dir(e)));
  yield pAll(excludes, e => fs.move(rel(name(e)), join(dir(e), name(e))));
});

/**
 * Merges two sets of glob patterns with one set having more priority than
 * than the other.
 * @param {Array} defaultPatterns The default of set of glob patterns
 * @param {Array} patterns        The overriding set of glob patterns
 * @return {Array}                 The array of merged paths.
 */
let mergePatterns = Q.async(function* (defaultPatterns, patterns) {
  let [defaultPaths, paths] = yield Promise.all([
    globby([defaultPatterns]),
    globby([patterns])
  ]);

  let merged = {};
  let name = p => path.basename(p).replace(/\..*$/, '');

  defaultPaths.forEach(p => merged[name(p)] = p);
  paths.forEach(p => merged[name(p)] = p);

  return Object.keys(merged).map(key => merged[key]);
});

/**
 * Copy patterns from one directory to another creating
 * intermediate directories in the process.
 * @param {Array}   patterns The array of glob patterns
 * @param {String}  fromDir  The from directory
 * @param {String}  toDir    The to directory
 * @return {Array}            Array of paths of copied locations of file
 */
let copy = Q.async(function* (patterns, fromDir, toDir) {
  fromDir = path.resolve(fromDir);
  toDir = path.resolve(toDir);

  let paths = yield globby(patterns, { cwd: fromDir, nodir: true });
  let fPaths = paths.map(p => path.resolve(fromDir, p));
  let tPaths = paths.map(p => path.resolve(toDir, p));

  yield Promise.all(tPaths.map(p => fs.makeTree(path.dirname(p))));
  yield Promise.all(fPaths.map((p, i) => fs.copy(p, tPaths[i])));

  return tPaths;
});

/**
 * MingW, the environment used in Git Bash for Windows has taken upon itself
 * to convert the arguments that look like POSIX paths to Win32 paths.
 * This might screw up the arguments that aren't actually paths but something
 * like, well `baseurl`. So we need to fix the value of the argument if we're
 * in MingW environment.

 * Look at following url for further information.
 * http://www.mingw.org/wiki/Posix_path_conversion

 * You can run your commands with `MSYS_NO_PATHCONV=1` if you want to disable
 * path conversion from command line.
 * Eg. MSYS_NO_PATHCONV=1 command --baseurl='/elements'
 * http://stackoverflow.com/a/34386471/1310569
 * @param  {String} pth The path to fix
 * @return {String}     The fixed path
 */
function fixMsys(pth) {
  // detect if running in Msys envirnment
  if (!process.env.MSYSTEM && !process.env.MSYS) {
    return pth;
  }

  // following list of prefixes is not complete they are what I could find
  // on my machine by playing around. Don't hesitate to add more.

  // found on windows git bash
  let prefix1 = 'C:\\Program Files\\Git';

  // found on windows git bash running inside ConEmu
  let prefix2 = 'C:/Program Files/Git';

  if (pth.indexOf(prefix1) !== -1) {
    pth = pth.replace(prefix1, '');
    pth = pth.replace(/\\/g, '/');
  }

  else if (pth.indexOf(prefix2) !== -1) {
    pth = pth.replace(prefix2, '');
  }

  return pth;
}

/**
 * Download and extract the master branch archive of a repo from github
 * @param {String} repo   The repo to download and extract
 * @param {String} exPath The path to extract at
 * @param {String} name   The name of the extracted repo
 * @return {String}        The path to the extracted repo
 */
let extractGhRepo = Q.async(function* (repo, exPath, name) {
  let repoName = repo.replace(/^[^\/]+\/(.+)$/, '$1');

  if (repoName === repo) {
    throw new Error(`Bad repo: ${repo}. Couldn't find repo name.`);
  }

  let arUrl = `https://github.com/${repo}/archive/master.tar.gz`;
  exPath = path.resolve(exPath);

  yield new Promise((resolve, reject) => {
    let extractStream = tar.extract(exPath);

    extractStream.on('finish', resolve);
    extractStream.on('error', reject);
    request(arUrl)
      .pipe(gunzip())
      .pipe(extractStream);
  });

  let fromPath = path.resolve(exPath, `${repoName}-master`);
  let toPath = path.resolve(exPath, name);

  yield fs.rename(fromPath, toPath);

  return toPath;
});

/**
 * Extract the hash of dependendencies (including dev) from a `bower.json` file
 * @param  {String} bowerPath The path to `bower.json`
 * @return {Object}           The package names and bower install endpoints
 */
function getBowerDeps(bowerPath) {
  return fs.read(bowerPath).then(bower => {
    bower = JSON.parse(bower || '{}');
    let deps = Object.assign({}, bower.dependencies, bower.devDependencies);
    let parsedDeps = {};

    for (let key of Object.keys(deps)) {
      let ep = bep.json2decomposed(key, deps[key]);
      let install = ep.source;

      if (ep.target !== '*') {
        install += `#${ep.target}`;
      }

      parsedDeps[ep.name] = install;
    }

    return parsedDeps;
  });
}

/**
 * Conver to the dependency object
 * @param  {String} baseDir   Path to element directory
 * @param  {String} elInstall Bower endpoint of the element
 * @param  {Object} bowerDeps Hash of packages and endpoints
 * @param  {String} type      whether `link` or `script` type
 * @param  {[type]} pth       [description]
 * @return {[type]}           [description]
 */
function _toDep(baseDir, elInstall, bowerDeps, type, pth) {
  let elName = path.basename(baseDir);
  // the directory in which the components are installed this will
  // almost always be `bower_components` directory
  let parentDir = path.basename(path.dirname(baseDir));

  let arr = path.normalize(pth).split(path.sep);
  // we want the paths to be relative to the directory in which
  // so remove the parts of path appearing before `parentDir`
  arr = arr.slice(arr.indexOf(parentDir) + 1);
  let pkg = arr[0];

  return {
    relPath: arr.join('/'),
    // only outside packages can be resolved from bower.json
    install: pkg !== elName ? bowerDeps[pkg] : elInstall,
    type: type
  };
}

/**
 * Extract the relevent information for dependencies for a demo file. The
 * dependncies can be html imports or script references. The relevent info
 * is install endpoints for packages of dependencies.
 * @param {String} bowerPath     The file to resolve endpoints from
 * @param {String} demoFilePath  The file to parse for html imports
 * @param {String} elInstall     The install endpoint of element to be demoed
 * @return {Array}                The array of dependencies
 */
let extractDeps = Q.async(function* (bowerPath, demoFilePath, elInstall) {
  let baseDir = path.dirname(bowerPath);
  let re = path.basename(demoFilePath).replace(/\./, '\\.') + '$';
  let demoRe = new RegExp(re);
  let bowerDepsP = getBowerDeps(bowerPath);
  let hydroP = hydrolysis.Analyzer.analyze(demoFilePath);

  let [ hydro, bowerDeps ] = yield Promise.all([hydroP, bowerDepsP]);

  let docs = hydro.parsedDocuments || {};
  let scripts = hydro.parsedScripts || {};

  let toDepFromPath = _toDep.bind(null, baseDir, elInstall, bowerDeps);

  docs = Object.keys(docs)
    .map(toDepFromPath.bind(null, 'link'))
    // hydrolysis adds `index.html` to the `parsedDocuments` hash
    // but we want the dependencies only so we filter it out
    .filter(dep => !demoRe.test(dep.relPath));

  scripts = Object.keys(scripts)
    .map(toDepFromPath.bind(null, 'script'));

  return scripts.concat(docs);
});

function tryRead(p) {
  return fs.exists(p)
    .then(exists => exists ? fs.read(p) : Promise.resolve(''));
}

/**
 * Search and extract the inner html for a particular tag
 * @param {String} name  name of the tag to search
 * @param {String} fpath the html file to search in
 * @return {String}       the inner html
 */
let extractInnerHtml = Q.async(function* (name, fpath) {
  let text = yield fs.read(fpath);
  let $ = cheerio.load(text);
  let innerHTML = $(name).html() || '';

  innerHTML = innerHTML.split('\r\n')
    .map(line => line.replace(/^\s+/, '').replace(/\s+$/, ''))
    .filter(line => Boolean(line))
    .join('');

  return innerHTML;
});

function toDashCase(str) {
  return str.toLowerCase().replace(/[ _]+/g, '-');
}

function toCamelCase(str) {
  return str.replace(/-(.)/g, (m, m1) => m1.toUpperCase());
}

function fromDashCase(str) {
  return str.toLowerCase().replace(/(^|-)(\w)/g, (m, m1, m2) => {
    return (m1 ? ' ' : '') + m2.toUpperCase();
  });
}

function type(val) {
  let t = Object.prototype.toString.call(val);

  return t.replace(/\[object (\w+)\]/, (m, m1) => m1.toLowerCase());
}

function isString(val) {
  return type(val) === 'string';
}

function isBoolean(val) {
  return type(val) === 'boolean';
}

function isNumber(val) {
  return type(val) === 'number';
}

function isObject(val) {
  return type(val) === 'object';
}

function isArray(val) {
  return type(val) === 'array';
}

function isRegExp(val) {
  return type(val) === 'regexp';
}

function isFunction(val) {
  return type(val) === 'function';
}

function ifPresentCheckType(tp, name, val) {
  if (val === undefined) {
    return;
  }

  assert(type(val) === tp, `${name} has to be ${tp}`);
}

function bowCmd(cmd, ...args) {
  return new Promise((res, rej) => {
    bower.commands[cmd](...args)
      .on('end', (...values) => res(...values))
      .on('error', (...reasons) => rej(...reasons));
  });
}

function bowInstall(pkgs, cwd) {
  let opts = cwd ? { cwd: cwd } : undefined;

  return bowCmd('install', pkgs, undefined, opts);
}

module.exports = {
  fixMsys: fixMsys,
  copy: copy,
  mergePatterns: mergePatterns,
  removeBowerComponents: removeBowerComponents,
  extractGhRepo: extractGhRepo,

  getBowerDeps: getBowerDeps,
  extractDeps: extractDeps,
  tryRead: tryRead,
  extractInnerHtml: extractInnerHtml,

  toDashCase: toDashCase,
  toCamelCase: toCamelCase,
  fromDashCase: fromDashCase,

  isString: isString,
  isBoolean: isBoolean,
  isNumber: isNumber,
  isObject: isObject,
  isArray: isArray,
  isFunction: isFunction,
  isRegExp: isRegExp,
  ifPresentCheckType: ifPresentCheckType,

  bowCmd: bowCmd,
  bowInstall: bowInstall
};
