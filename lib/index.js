var fs = require('fs');
var url = require('url');
var os = require('os');
var stream = require('stream');

var vasync = require('vasync');
var manta = require('manta');
var moment = require('moment');
var colors = require('colors/safe');
var handlebars = require('handlebars');
var JiraClient = require('jira-client');
var request = require('request');

var CONFIG = require('../etc/config.json');

var ID = process.argv[2].toUpperCase();

var mailer = require('nodemailer')
  .createTransport(CONFIG.nodemailer.smtpTransport);

var readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

var jira = new JiraClient({
    protocol: 'https:',
    host: process.env.JIRA_DOMAIN,
    username: process.env.JIRA_USER,
    password: process.env.JIRA_PASS,
    base: process.env.JIRA_PATH,
    apiVersion: '2',
    strictSSL: true
  });

var mclient = manta.createClient({
    sign: manta.privateKeySigner({
        key: CONFIG.MANTA_PRIVATE_KEY ||
          fs.readFileSync(CONFIG.MANTA_KEY_MATERIAL, 'utf8'),
        keyId: CONFIG.MANTA_KEY_ID,
        user: CONFIG.MANTA_USER,
        subuser: CONFIG.MANTA_SUBUSER
    }),
    user: CONFIG.MANTA_USER,
    subuser: CONFIG.MANTA_SUBUSER,
    url: CONFIG.MANTA_URL
  });

// Compile handlebar templates
var template = {};
for (var i = 0; i < CONFIG.templates.length; i++) {
  var tpl = CONFIG.templates[i];
  template[tpl] = {
    txt: handlebars
      .compile(fs.readFileSync(CONFIG.templatePath + tpl + '.txt')
      .toString()),
    html: handlebars
      .compile(fs.readFileSync(CONFIG.templatePath + tpl + '.html')
      .toString())
  };
}

function OK(what, msg) {
  console.log(colors.black.bgGreen(' ✓ '), colors.bold(what) + ':', msg);
}

function FAIL(what, msg) {
  console.error(colors.black.bgRed(' ✕ '), colors.bold(what) + ':', msg);
}

function WARN(what, msg) {
  console.error(colors.black.bgYellow(' → '), colors.bold(what) + ':', msg);
}

// add a leading space to the text output
function lpad(txt) {
  return ' ' + txt.split('\n').join('\n ');
}

// combined fields for status.io incident details
function incidentDetails(ctx) {
  var details = '\r\n' + 
    'CURRENT STATUS:\r\n' + 
      ctx.current_status_txt + '\r\n' +
    '\r\nIMPACT:\r\n' +
      ctx.impact_txt + '\r\n';

  if (0 && !ctx.resolved) {
    details += '\r\nRESOLUTION ACTIONS:\r\n' + 
      ctx.resolution_actions_txt;
  }

  return details + '\r\n\r\n' + 'Internal ID: ' + ctx.ID;
}

// Fetch JIRA then transform and render the notices, everything is stored in ctx
function getJIRAByID(next) {
  jira
    .findIssue(ID)
    .then(function(issue) {
      var project = ID.split('-')[0];
      var conf = CONFIG[project];

      if (!conf) {
        // Each JIRA project needs its own sub-configuration in the config.json
        // see "SCI": {...} in config.json as an example.
       return next(new Error('Unsupported JIRA project:' + project));
      }
      var ctx = {
        ID: ID,
        project: project,
        conf: conf,
        summary: issue.fields.summary,
        cloud: conf.CLOUD,
        jira: 'https://' + process.env.JIRA_DOMAIN + '/' + process.env.JIRA_PATH,
        issue: issue.fields,
        current_status_txt: lpad(issue.fields[conf.CURRENT_STATUS]),
        current_status: issue.fields[conf.CURRENT_STATUS],
        impact: issue.fields[conf.IMPACT],
        impact_txt: lpad(issue.fields[conf.IMPACT_TXT]),
        resolution_actions: issue.fields[conf.RESOLUTION_ACTIONS],
        resolution_actions_txt: lpad(issue.fields[conf.RESOLUTION_ACTIONS]),
        incident_status: issue.fields.status.name,
        urgency: issue.fields[conf.URGENCY],
        services: issue.fields[conf.SERVICES].map(function(o) { return o.value } ),
        details: {
          priority: issue.fields.priority.name,
          root_cause: issue.fields[conf.ROOT_CAUSE],
          incident_start_time: moment(issue.fields[conf.START])
            .utc().format(conf.DATE_FORMAT),
          incident_end_time: moment(issue.fields[conf.END])
            .utc().format(conf.DATE_FORMAT),
          incident_duration: issue.fields[conf.DURATION],
          incident_description: issue.fields.description,
          incident_status: issue.fields.status.name,
          issue_type: issue.fields.issuetype.name,
          incident_manager: (issue.fields.assignee) ?
            issue.fields.assignee.displayName : null
        },
        msg: {
          from: CONFIG.nodemailer.sender
        },
        statuspageio: {
          headers: {
            'Authorization': 'OAuth ' + CONFIG.STATUSPAGE_API_TOKEN,
            'Connection': 'close'
          }
        }
      };

      // Create comma separated list of impacted Locations
      if (ctx.services) {
        ctx.details.location = ctx.services.join(', ');
      } else {
        ctx.details.location = 'None';
      }

      if (!issue.fields[conf.ESCALATION_LEVEL]) {
        return next(new Error('No Escalation Level defined for ' + ID));
      }
      var esc_level = issue.fields[conf.ESCALATION_LEVEL].value.split(' ')[2];
      if (esc_level && process.env['IM_NOTICES_EMAIL_L' + esc_level]) {
        ctx.msg.to = process.env['IM_NOTICES_EMAIL_L' + esc_level];
      } else {
        ctx.msg.to = conf.ESCALATION_RECIPIENTS[issue.fields[conf.ESCALATION_LEVEL].value];
      }
      ctx.msg.subject = 'Incident Alert: ' +  ID + ' - ' + issue.fields.summary;

      if (issue.fields.status.name === 'Resolved') {
        ctx.resolved = true;
        ctx.msg.subject = '[Resolved] ' + ctx.msg.subject;
      }

      // Render handlebar templates
      ctx.msg.txt = template.internal_initial.txt(ctx);
      ctx.msg.html = template.internal_initial.html(ctx);

      next(null, ctx);

  }).catch(function(err) {
    console.error(err.message || err);
    next(new Error('Unable to retrieve JIRA: ' + ID));
  });
}

function previewNotice(ctx, next) {
  console.log('To: ' + ctx.msg.to);
  console.log('Subject: ' + ctx.msg.subject);
  console.log(ctx.msg.txt);
  next(null, ctx);
}

function confirmPreview(ctx, next) {
  readline.question('Send notification? [Y/n] ', function (answer) {
    if (answer !== 'Y') {
      return next('Notification not sent. Please enter "Y" to send.');
    }
    next(null, ctx);
  });
}

function sendNotice(ctx, next) {
  mailer.sendMail(ctx.msg, function (err, ok) {
    if (err || !ok) {
      console.error(err);
      return next(new Error('Could not send email'));
    }
    OK('Email', 'Sent. ' + ok.response);
    next(null, ctx);
  });
}

// Update "External Notice Link" fields
function updateJIRA(ctx, next) {
  var update = {fields: {}};
  var now = moment().utc().format(CONFIG.JIRA_DATE_FORMAT);

  if (ctx.statuspageio.create) {
    update.fields[ctx.conf.EXTERNAL_LINK] = ctx.statuspageio.extLink;
  }
  jira
    .updateIssue(ctx.ID, update)
    .then(function () {
      OK('JIRA', '"Last Internal Notice" field updated.');
      if (ctx.statuspageio.create) {
        OK('JIRA', '"External Notice Link" added.');
      }
      next(null, ctx);
    })
    .catch(function(err) {
      console.error(now, err.message || err);
      next(new Error('JIRA not updated.'));
    });
}

// Attach the text rendered email to the JIRA as a comment.
function addCommentToJIRA(ctx, next) {
  var comment;
  if (ctx.issue.ci_reason) { 
    comment = 'Notices sent (' + ctx.issue.ci_reason + ').\n' + '{noformat}\n' + ctx.msg.txt + '\n{noformat}';
  } else {
    comment = 'Notices sent.\n' + '{noformat}\n' + ctx.msg.txt + '\n{noformat}';
  } 
  jira
    .addComment(ctx.ID, comment)
    .then(function () {
      OK('JIRA', 'Comment added with notice details.');
      next(null, ctx);
    })
    .catch(function(err) {
      console.error(err.message || err);
      next(new Error('Unable to add comment to JIRA.'));
    });
}

// setup ctx.statuspageio object and determine if there is already a 
// status.io notice to update or if a new one needs to be created.
function checkStatusNotice(ctx, next) {
  if (ctx.conf.SKIP_STATUS) {
    return next(null, ctx);
  }
  var extLink = url.parse(ctx.issue[ctx.conf.EXTERNAL_LINK] || ''); // extract the status.io external link from JIRA
  if (extLink.protocol) { // check it's populated
      ctx.statuspageio.incID = extLink.path.split('/').pop(); // extract the statuspage.io incident ID
      if (ctx.statuspageio.incID) { // set update to true if it exists
        ctx.statuspageio.update = true;
      } else {
        FAIL('statuspage.io', 'The JIRA has an invalid "External Notice Link".');
        console.error('Continuing, but no actions will be taken on statuspage.io');
      }
  } else {
      ctx.statuspageio.create = true; // otherwise set create to true
  }
  ctx.statuspageio.status = ctx.conf.INCSTATUS_MAP[ctx.incident_status];
  next(null, ctx);
}

// If you delete the status.io notice without removing the link on the JIRA or 
// if the link is invalid for some other reason statuspage.io returns an auth error
// instead of something useful so this function attempts to fetch the incident
// before updating it later on. 
function sanityCheckStatusNotice(ctx, next) {
  if (!ctx.statuspageio.update) { // if we are not updating an existing incident, skip these checks
    return next(null, ctx);
  }
  request.get({
    url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/incidents.json',
    json: true,
    headers: ctx.statuspageio.headers
  }, function (err, httpResponse, body) {
      if (err) {
        ctx.statuspageio.update = false;
        ctx.statuspageio.create = false;
        FAIL('statuspage.io', err || body);
        console.error('Continuing, but no actions will be taken on statuspage.io');
        return next(null, ctx);
      }

      // If we're updating an incident confirm it is listed in incidents.json
      for (var i = 0; i < body.length; i++) {
        if (body[i].id === ctx.statuspageio.incID) {
          return next(null, ctx);
        }
      }

      FAIL('statuspage.io', 'The JIRA has an "External Notice Link" but it could not be found on statuspage.io.');
      console.error('Continuing, but no actions will be taken on statuspage.io');

      ctx.statuspageio.update = false;

      next(null, ctx);
  });
}

function createStatusNotice(ctx, next) {
  if (!ctx.statuspageio.create) {
    return next(null, ctx);
  }

  // If there's not an existing status.io incident and the issue is resolved, 
  // we probably need to create a historical incident. This is not yet supported.
  if (ctx.resolved === true) {
    FAIL('statuspage.io', 'im-notices does not yet support historical incidents.');
    console.error('The JIRA is Resolved, but there is no existing status.io ' + 
      'incident attached to the JIRA.');
    console.error('You will need to create a historical incident manually.');
    console.error('Continuing, but no actions will be taken on statuspage.io');
    ctx.statuspageio.create = false;
    return next(null, ctx);
  }

  var requestBody = {
    incident: {
      name: ctx.summary,
      status: ctx.conf.INCSTATUS_MAP[ctx.incident_status],
      //impact_override: "critical", // FIXME - get from JIRA
      body: incidentDetails(ctx),
      component_ids: [ ctx.components.join(',') ],
      deliver_notifications: true
    }
  };

  request.post({
    url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/incidents.json',
    headers: ctx.statuspageio.headers,
    json: requestBody
  }, function (err, httpResponse, body) {
    if (err) {
      return next(err);
    }
    if (body.status && body.status.error === 'yes') {
      FAIL('statuspage.io', body.status.message);
      console.error('Continuing, but a notice was not posted on status.io');
      console.error('Please report this error.', body);
      ctx.logErrors = {issue: ctx.issue, request: requestBody};
    } else {
      ctx.statuspageio.extLink = ctx.conf.INCIDENT_URL + body.id;
      OK('statuspage.io', 'Notice posted: ' + ctx.statuspageio.extLink);
    }

    var i;
    for (i = 0; i < ctx.components.length; i++) {
      var requestBody2 = {
        component: {
          status: ctx.conf.IMPACT_MAP[ctx.issue[ctx.conf.SERVICE_IMPACT].value]
        }
      };
  
      request.patch({
        url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/components/' + ctx.components[i] + '.json',
        headers:  ctx.statuspageio.headers,
        json: requestBody2,
      }, function (err, httpResponse, body) {
        if (err) {
          return next(err);
        }
        if (body.status && body.status.error === 'yes') {
          FAIL('statuspage.io', body.status.message);
        } else {
          OK('statuspage.io', 'Component updated.');
        }
      });
    }
    next(null, ctx);
  });
}

function updateStatusNotice(ctx, next) {
  if (!ctx.statuspageio.update) {
    return next(null, ctx);
  }
  var requestBody = {
    incident: {
    name: ctx.summary,
    component_ids: [ ctx.components.join(',') ],
    deliver_notifications: true,
    //impact_override: "none", //FIXME
    body: incidentDetails(ctx)
    }
  };

  requestBody.incident.status = ctx.conf.INCSTATUS_MAP[ctx.incident_status.value];

  request.patch({
    url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/incidents/' + ctx.statuspageio.incID + '.json',
    headers:  ctx.statuspageio.headers,
    json: requestBody,
  }, function (err, httpResponse, body) {
    if (err) {
      return next(err);
    }
    if (body.status && body.status.error === 'yes') {
      FAIL('statuspage.io', body.status.message);
    } else {
      OK('statuspage.io', 'Notice updated.');
    }
    ctx.statuspageio.extLink = ctx.conf.INCIDENT_URL + body.id;
  });

  var i;
  for (i = 0; i < ctx.components.length; i++) {
    var requestBody2 = {
      component: {
        status: (ctx.conf.INCSTATUS_MAP[ctx.incident_status] === "monitoring" || ctx.conf.INCSTATUS_MAP[ctx.incident_status] === "resolved") ? "operational" : ctx.conf.IMPACT_MAP[ctx.issue[ctx.conf.SERVICE_IMPACT].value]
      }
    };
    
    request.patch({
      url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/components/' + ctx.components[i] + '.json',
      headers:  ctx.statuspageio.headers,
      json: requestBody2,
    }, function (err, httpResponse, body) {
      if (err) {
        return next(err);
      }
      if (body.status && body.status.error === 'yes') {
        FAIL('statuspage.io', body.status.message);
      } else {
        OK('statuspage.io', 'Component updated.');
      }
    });
  }
  return next(null, ctx);
}

function saveMantaLog(ctx, next) {
  var path = CONFIG.MANTA_UPLOAD_PATH + moment().format('YYYYMMDD/HHmm.ss') + '_' + os.hostname() + '.log';
  var input = new stream.Readable();

  ctx.msg.details = ctx.details;
  ctx.msg.datetime = moment().format();
  ctx.msg.errors = ctx.logErrors || null;

  var logContent = JSON.stringify(ctx.msg, null, 4);

  input.push(logContent);
  input.push(null);

  mclient.put(path, input, {mkdirs: true}, function (err) {
      if (err) {
        path = CONFIG.MANTA_LOCAL_FALLBACK_PATH + 'im-notices.' + moment().format('YYYYMMDD-HHmm.ss') + '_localhost.log';
        fs.writeFileSync(path, logContent);
        console.error('Local file saved at: ' + path);
        console.error(err.message || err);
        return next(new Error('Unable to write log to Manta ' + path));
      }
      OK('Manta', 'Log uploaded to ' + path);
      mclient.close();
      next(null, ctx);
  });
}

// Checks if the JIRA has been updated since you've last seen the preview
function isPreviewStale(ctx, next) {
  jira
    .findIssue(ID)
    .then(function(issue) {
      if (issue.fields.updated !== ctx.issue.updated) {
        WARN('JIRA', 'The notice preview is stale. Please re-run im-notices ' + 
          'for the latest data.');
        return next(new Error('JIRA has been updated!'));
      }
      next(null, ctx);
  }).catch(function(err) {
    console.error(err.message || err);
    next(new Error('Unable to retrieve JIRA: ' + ID));
  });
}


// Convert JIRA service to statuspage.io component
function validateJIRA(ctx, next) {
  if (ctx.conf.SKIP_STATUS) {
    return next(null, ctx);
  }
  if (ctx.issue.issuetype.name === 'Security') {
    FAIL('statuspage.io', 'Manual notifications required for any ' + 'security-related incident. Aborting.');
    return next(new Error('Security Type chosen on JIRA'), ctx);
  }

  if (ctx.issue.issuetype.name === 'Compute Infrastructure') {
// FIXME https://github.com/andrewh1978/sup-im-notices/blob/5ddf97dbb02c01d122cf8f2089edfd68817d8195/lib/index.js#L562
  }

  if (ctx.resolution_actions.length == 0) {
    FAIL('JIRA Resolution Actions must not be empty');
    return next(new Error('JIRA Resolution Actions must not be empty'), ctx);
  }
  if (ctx.details.incident_description.length == 0) {
    FAIL('JIRA description must not be empty');
    return next(new Error('JIRA description must not be empty'), ctx);
  }
  if (ctx.current_status.length == 0) {
    FAIL('JIRA Current Status must not be empty');
    return next(new Error('JIRA Current Status must not be empty'), ctx);
  }
  request.get({
    url: CONFIG.STATUSPAGE_URL + ctx.conf.STATUSPAGE_PAGE + '/components.json',
    json: true,
    headers: ctx.statuspageio.headers
  }, function (err, httpResponse, body) {
    if (err || body.error) {
      WARN('statuspage.io', err || body);
      WARN('Continuing, but the JIRA\'s Services could not be validated.');
      return next(null, ctx);
    }
    var i;
    var temp = {};
    var sp_components = {};
    // First pass, get the group names
    for (i = 0; i < body.length; i++) {
      if (body[i].group_id === null) {
        temp[body[i].id] = body[i].name;
      }
    }
    // Next, get everything
    for (i = 0; i < body.length; i++) {
      if (body[i].group_id === null) {
        sp_components[body[i].name] = body[i].id;
      } else {
        sp_components[body[i].name + ": " + temp[body[i].group_id]] = body[i].id;
      }
    }
    // Now populate ctx.components with a list of component IDs
    ctx.components = [];
    for (i = 0; i < ctx.services.length; i++) {
      if (sp_components[ctx.services[i]]) {
        ctx.components.push(sp_components[ctx.services[i]]);
      } else {
        FAIL("Service '" + ctx.services[i] + "' not found in statuspage.io");
        return next(new Error("Service '" + ctx.services[i] + "' not found in statuspage.io"), ctx);
      }
    }
    return next(null, ctx);
  });
}

module.exports = function () {
  vasync.waterfall([
    getJIRAByID,
    previewNotice,
    validateJIRA,
    confirmPreview,
    isPreviewStale,
    sendNotice,
    checkStatusNotice,
    sanityCheckStatusNotice,
    createStatusNotice,
    updateStatusNotice,
    updateJIRA,
    addCommentToJIRA,
    saveMantaLog
  ], function (error) {
    readline.close();
    if (error) {
      process.exitCode = 1;
      FAIL('Error', error);
    }
  });
};
