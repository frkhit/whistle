var net = require('net');
var rules = require('./index');
var util = require('../util');
var config = require('../config');
var Storage = require('./storage');
var system = require('./system');
var httpMgr = require('../util/http-mgr');

var INTERVAL = 1000 * 60 * 60;
var MAX_URL_LEN = 10 * 1024;
var MAX_HEADERS_LEN = 128 * 1024;
var MAX_BODY_LEN = 256 * 1024;
var MAX_METHOD_LEN = 64;
var MAX_HISTORY_LEN = 36;
var history = [];
var rulesStorage = new Storage(config.rulesDir);
var valuesStorage = new Storage(config.valuesDir);
var propertiesStorage = new Storage(config.propertiesDir);
var shadowRules = config.shadowRules;
var LINE_END_RE = /\n|\r\n|\r/g;
var MAX_REMOTE_RULES_COUNT = 12;
var REMOTE_RULES_RE = /^\s*@(`?)(whistle\.[a-z\d_\-]+(?:\/[^\s#]*)?|(?:https?:\/\/|[a-z]:[\\/]|~?\/)[^\s#]+)\s*\1(?:#.*)?$/img;
var MAX_COUNT_BY_IMPORT = 60;
var inlineValues;
var CONTROL_RE = /[\u001e\u001f\u200e\u200f\u200d\u200c\u202a\u202d\u202e\u202c\u206e\u206f\u206b\u206a\u206d\u206c]+/g;
var MULTI_LINE_VALUE_RE = /^[^\n\r\S]*(```+)[^\n\r\S]*(\S+)[^\n\r\S]*[\r\n]([\s\S]+?)[\r\n][^\n\r\S]*\1\s*$/mg;

try {
  history = JSON.parse(propertiesStorage.readFile('composerHistory'));
  if (Array.isArray(history)) {
    history = history.filter(checkHistory);
    history = history.slice(0, MAX_HISTORY_LEN);
  } else {
    history = [];
  }
} catch(e) {}

function checkHistory(data) {
  return typeof data.url === 'string' && typeof data.method === 'string'
   && typeof data.headers === 'string' && typeof data.body === 'string';
}


process.nextTick(function() {
  parseRules();
});
/**
* rules
*/

function resolveInlineValues(str) {
  str = str && str.replace(CONTROL_RE, '').trim();
  if (!str || str.indexOf('```') === -1) {
    return str;
  }
  return str.replace(MULTI_LINE_VALUE_RE, function(_, __, key, value) {
    inlineValues = inlineValues || {};
    if (!inlineValues[key]) {
      inlineValues[key] = value;
    }
    return '';
  });
}

function parseHosts(text) {
  if (typeof text != 'string'
|| !(text = text.trim())) {
    return '';
  }
  var result = [];
  text.split(/\n|\r\n|\r/g)
.forEach(function(line) {
  line = line.replace(/#.*$/, '').trim();
  if (!line) {
    return;
  }
  line = line.split(/\s+/);
  var pattern = line[0];
  if (net.isIP(pattern)) {
    line.slice(1).forEach(function(matcher) {
      !/\//.test(matcher) && result.push(pattern + ' ' + matcher);
    });
  } else if (!/\//.test(pattern) && line[1] && net.isIP(line[1])) {
    result.push(line[1] + ' ' + pattern);
  }
});

  return result.join('\r\n');
}

function reverseRules(text, orig) {
  if (!text) {
    return '';
  }
  text = resolveInlineValues(text);
  text = text.split(LINE_END_RE).reverse();
  return orig ? text : text.join('\n');
}

function parseRules() {
  var rulesText, backRulesFirst;
  if (propertiesStorage.getProperty('disabledAllRules')) {
    rulesText = config.allowDisableShadowRules ? null : shadowRules;
  } else {
    var value = [];
    var hosts =  propertiesStorage.getProperty('syncWithSysHosts') ? [] : null;
    if (!config.multiEnv) {
      getAllRulesFile().forEach(function(file) {
        if (file.selected) {
          value.push(file.data);
          if (hosts) {
            var sysHosts = parseHosts(file.data);
            if (sysHosts) {
              hosts.push('#\r\n# ' + file.name + '\r\n#' + '\r\n' + sysHosts);
            }
          }
        }
      });
    }
    backRulesFirst = propertiesStorage.getProperty('backRulesFirst') === true;
    var defaultRules = defaultRulesIsDisabled() ? null : getDefaultRules();
    if (defaultRules) {
      if (backRulesFirst) {
        value.unshift(defaultRules);
      } else {
        value.push(defaultRules);
      }
    }

    if (hosts && defaultRules) {
      var sysHosts = parseHosts(defaultRules);
      if (sysHosts) {
        hosts.push('#\r\n# Default\r\n#' + '\r\n' + sysHosts);
      }
    }
    if (backRulesFirst) {
      value = reverseRules(value.join('\n'), true);
    }
    value = value && value.join('\r\n');
    if (shadowRules) {
      if (backRulesFirst) {
        value = reverseRules(shadowRules) + '\n' + value;
      } else {
        value += '\n' + shadowRules;
      }
    }
    rulesText = value;
    if (hosts) {
      hosts = hosts.join('\r\n\r\n');
      system.setHosts(hosts, util.noop);
    }
  }
  var index = 0;
  if (rulesText) {
    rulesText = rulesText.replace(REMOTE_RULES_RE, function(_, apo, rulesUrl) {
      if (index >= MAX_REMOTE_RULES_COUNT) {
        return '';
      }
      ++index;
      rulesUrl = util.getPluginRulesUrl(rulesUrl);
      if (apo) {
        rulesUrl = util.setConfigVar(rulesUrl);
      }
      var remoteRules = httpMgr.add(rulesUrl);
      return backRulesFirst ? reverseRules(remoteRules) : remoteRules;
    });
  }
  if (!index) {
    httpMgr.clean();
  }
  rules.parse(rulesText, null, inlineValues);
  inlineValues = null;
}

httpMgr.addChangeListener(parseRules);

exports.parseRules = parseRules;

function setDefaultRules(data) {
  data = typeof data != 'string' ? '' : data;
  var oldData = rulesStorage.getProperty('defalutRules') || '';
  rulesStorage.setProperty('defalutRules', data);
  parseRules();
  return data !== oldData;
}

function getDefaultRules() {
  return rulesStorage.getProperty('defalutRules');
}

function disableDefaultRules() {
  rulesStorage.setProperty('disabledDefalutRules', true);
  parseRules();
}

function enableDefaultRules() {
  rulesStorage.setProperty('disabledDefalutRules', false);
  parseRules();
}

function defaultRulesIsDisabled() {
  return rulesStorage.getProperty('disabledDefalutRules');
}

function selectRulesFile(file) {
  if (!rulesStorage.existsFile(file) || config.multiEnv) {
    return;
  }

  var selectedList = allowMultipleChoice() ? getSelectedRulesList() : [];
  if (selectedList.indexOf(file) == -1) {
    selectedList.push(file);
    rulesStorage.setProperty('selectedList', selectedList);
  }
  parseRules();
  return selectedList;
}

function unselectRulesFile(file, force) {
  if (!force && config.multiEnv) {
    return;
  }
  var selectedList = getSelectedRulesList();
  var index = selectedList.indexOf(file);
  if (index != -1) {
    selectedList.splice(index, 1);
    rulesStorage.setProperty('selectedList', selectedList);
  }
  parseRules();

  return selectedList;
}

function allowMultipleChoice() {
  return propertiesStorage.getProperty('allowMultipleChoice');
}

function clearSelection() {
  rulesStorage.setProperty('selectedList', []);
  parseRules();
}

function getSelectedRulesList() {
  if (config.multiEnv) {
    return [];
  }
  var selectedList = rulesStorage.getProperty('selectedList');
  if (!Array.isArray(selectedList)) {
    selectedList = [];
    rulesStorage.setProperty('selectedList', selectedList);
  }
  return selectedList;
}

function removeRulesFile(file) {
  unselectRulesFile(file, true);
  return rulesStorage.removeFile(file);
}

function renameRulesFile(file, newFile) {
  if (!rulesStorage.renameFile(file, newFile)) {
    return;
  }

  var selectedList = getSelectedRulesList();
  var index = selectedList.indexOf(file);
  if (index != -1) {
    selectedList[index] = newFile;
    rulesStorage.setProperty('selectedList', selectedList);
  }
  return true;
}

function addRulesFile(file, data) {
  return rulesStorage.writeFile(file, data);
}

function getAllRulesFile() {
  var list = rulesStorage.getFileList();
  var selectedList = getSelectedRulesList();
  list.forEach(function(file) {
    file.selected = selectedList.indexOf(file.name) != -1;
  });
  return list;
}

function resetRulesIfResort(fromName, toName) {
  var selectedList = getSelectedRulesList();
  if (selectedList.indexOf(fromName) == -1 && selectedList.indexOf(toName) == -1) {
    return;
  }
  parseRules();
}

exports.rules = {
  enableBackRulesFirst: function(backRulesFirst) {
    var curFlag = propertiesStorage.getProperty('backRulesFirst') === true;
    if (curFlag !== backRulesFirst) {
      propertiesStorage.setProperty('backRulesFirst', backRulesFirst);
      parseRules();
    }
  },
  moveTo: function(fromName, toName, clientId) {
    if (rulesStorage.moveTo(fromName, toName)) {
      resetRulesIfResort(fromName, toName);
      config.setModified(clientId, true);
      return true;
    }
  },
  get: function(file) {
    return rulesStorage.readFile(file);
  },
  getSysHosts: system.getHosts,
  setSysHosts: system.setHosts,
  remove: function(file, clientId) {
    if (removeRulesFile(file)) {
      config.setModified(clientId, true);
    }
  },
  add: function(file, data, clientId) {
    if (addRulesFile(file, data)) {
      config.setModified(clientId, true);
    }
  },
  rename: function(file, newFile, clientId) {
    if (renameRulesFile(file, newFile)) {
      config.setModified(clientId, true);
    }
  },
  select: selectRulesFile,
  unselect: unselectRulesFile,
  list: getAllRulesFile,
  getDefault: getDefaultRules,
  setDefault: function(value, clientId) {
    if (setDefaultRules(value)) {
      config.setModified(clientId, true);
    }
  },
  enableDefault: enableDefaultRules,
  disableDefault: disableDefaultRules,
  defaultRulesIsDisabled: defaultRulesIsDisabled,
  parseRules: parseRules,
  clearSelection:clearSelection,
  getSelectedList: getSelectedRulesList
};


/**
* values
*/

function addValuesFile(file, data) {
  return valuesStorage.writeFile(file, data);
}

exports.values = {
  moveTo: function(fromName, toName, clientId) {
    if (valuesStorage.moveTo(fromName, toName)) {
      config.setModified(clientId);
      return true;
    }
  },
  add: function(file, data, clientId) {
    if (addValuesFile(file, data)) {
      config.setModified(clientId);
    }
  },
  get: function(file) {
    return valuesStorage.readFile(file);
  },
  remove: function remove(file, clientId) {
    if (valuesStorage.removeFile(file)) {
      config.setModified(clientId);
    }
  },
  rename: function(file, newFile, clientId) {
    if (valuesStorage.renameFile(file, newFile)) {
      config.setModified(clientId);
    }
  },
  list: function list() {
    var selectedFile = valuesStorage.getProperty('selectedFile');
    var list = valuesStorage.getFileList();
    if (selectedFile) {
      list.forEach(function(file) {
        file.selected = file.name == selectedFile;
      });
    }
    return list;
  },
  select: function(file) {
    typeof file == 'string' && valuesStorage.setProperty('selectedFile', file);
  },
  unselect: function() {
    valuesStorage.removeProperty('selectedFile');
  }
};



setTimeout(function getWhistleVersion() {
  util.getLatestVersion(config.registry, function(ver) {
    ver && propertiesStorage.setProperty('latestVersion', ver);
    setTimeout(getWhistleVersion, INTERVAL);
  });
}, 1000); //等待package的信息配置更新完成

/**
* properties
*/
var composerTimer;
function saveComposerHistory() {
  composerTimer = null;
  try {
    propertiesStorage.writeFile('composerHistory', JSON.stringify(history));
  } catch(e) {}
}

exports.properties = {
  set: function(name, value) {
    typeof name == 'string' ? propertiesStorage.setProperty(name, value) :
propertiesStorage.setProperties(name);
  },
  remove: function(name) {
    propertiesStorage.removeProperty(name);
  },
  get: function(name) {
    return propertiesStorage.getProperty(name);
  },
  getHistory: function() {
    return history;
  },
  addHistory: function(data) {
    if (!data.needResponse || !checkHistory(data)) {
      return;
    }
    var url = data.url;
    var method = data.method;
    var headers = data.headers;
    var body = data.body;
    var result = {
      date: Date.now(),
      url: url.length > MAX_URL_LEN ? url.substring(0, MAX_URL_LEN) : url,
      method: method.length > MAX_METHOD_LEN ? method.substring(0, MAX_METHOD_LEN) : method,
      headers: headers.length > MAX_HEADERS_LEN ? headers.substring(0, MAX_HEADERS_LEN) : headers,
      body: body.length > MAX_BODY_LEN ? body.substring(0, MAX_BODY_LEN) : body,
      isHexText: !!data.isHexText
    };
    for (var i = 0, len = history.length; i < len; i++) {
      var item = history[i];
      if (item.url === result.url && item.method === result.method
        && item.headers === result.headers && item.body === result.body) {
        history.splice(i, 1);
        break;
      }
    }
    history.unshift(result);
    var overflow = history.length - MAX_HISTORY_LEN;
    if (overflow > 0) {
      history.splice(MAX_HISTORY_LEN, overflow);
    }
    if (!composerTimer) {
      composerTimer = setTimeout(saveComposerHistory, 2000);
    }
  }
};

function getRules(rules) {
  if (Array.isArray(rules)) {
    return rules.join('\n');
  }
  if (typeof rules === 'string') {
    return rules;
  }
}

exports.addRules = function(rules, replace, clientId) {
  if (rules == null) {
    return;
  }
  replace = replace !== false;
  var hasChanged;
  if (Array.isArray(rules) || typeof rules == 'string') {
    if (replace !== false || !getDefaultRules()) {
      hasChanged = setDefaultRules(getRules(rules));
    }
  } else {
    var keys = Object.keys(rules).slice(keys, MAX_COUNT_BY_IMPORT);
    keys.forEach(function(name) {
      var item = name ? rules[name] : null;
      if (Array.isArray(item) || typeof item === 'string') {
        item = { rules: item };
      }
      if (item) {
        item.rules = getRules(item.rules);
        if (typeof item.replace !== 'boolean') {
          item.replace = replace;
        }
        if (name === 'Default') {
          if (typeof item.rules === 'string'
            && (item.replace !== false || !getDefaultRules())) {
            if (setDefaultRules(item.rules)) {
              hasChanged = true;
            }
          }
          if (item.enable) {
            enableDefaultRules();
          } else if (item.enable === false) {
            disableDefaultRules();
          }
        } else {
          if (typeof item.rules === 'string'
            && (item.replace !== false || !rulesStorage.existsFile(name))) {
            if (addRulesFile(name, item.rules)) {
              hasChanged = true;
            }
          }
          if (item.enable) {
            selectRulesFile(name);
          } else if (item.enable === false) {
            unselectRulesFile(name);
          }
        }
      }
    });
  }
  if (hasChanged) {
    config.setModified(clientId, true);
  }
};

exports.addValues = function(values, replace, clientId) {
  if (values == null || Array.isArray(values)) {
    return;
  }
  replace = replace !== false;
  var hasChanged;
  var keys = Object.keys(values).slice(0, MAX_COUNT_BY_IMPORT);
  keys.forEach(function(name) {
    if (/\s/.test(name) || (!replace && valuesStorage.existsFile(name))) {
      return;
    }
    var value = name ? values[name] : null;
    if (value == null) {
      return;
    }
    if (typeof value !== 'string') {
      value = JSON.stringify(value, null, '  ');
    }
    if (addValuesFile(name, value)) {
      hasChanged = true;
    }
  });
  if (hasChanged) {
    config.setModified(clientId);
  }
};
