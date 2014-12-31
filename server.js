var _ = require('lodash'),
  async = require('async'),
  github = new (require("github"))({version: "3.0.0"}),
  GitHubCommits = require("github-commits"),
  dotenv = require('dotenv'),
  restify = require('restify'),
  path = require('path'),
  querystring = require('querystring'),
  redis = require("redis"),
  server = restify.createServer(),
  uuid = require('uuid');

dotenv.load();

function Server() {
  _.extend(this, {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    redirectUri: process.env.REDIRECT_URI
  });

  this._createRoutes();
  this.oauth2 = this._initOAuth2();
  this.redis = require('redis-url').connect(process.env.REDISTOGO_URL);
}

Server.prototype._createRoutes = function() {
  var _this = this;

  server.use(restify.queryParser());
  server.use(restify.bodyParser());

  // serve static JavaScript and CSS.
  server.get(/\/javascript|css|images\/?.*/, restify.serveStatic({
    directory: path.resolve(__dirname, './assets')
  }));

  // serve the static index page.
  server.get('/', restify.serveStatic({
    directory: path.resolve(__dirname, './assets'),
    default: 'index.html'
  }));

  server.get('/auth', function(req, res, next) { _this.auth(req, res, next); });
  server.get('/callback', function(req, res, next) { _this.callback(req, res, next); });
  server.get('/stats', function(req, res, next) { _this.stats(req, res, next); });
};

Server.prototype._initOAuth2 = function() {
  return require('simple-oauth2')({
    clientID: this.clientId,
    clientSecret: this.clientSecret,
    site: 'https://github.com/login',
    tokenPath: '/oauth/access_token'
  });
};

Server.prototype.auth = function(req, res, next) {
  var authorization_uri = this.oauth2.authCode.authorizeURL({
    redirect_uri: this.redirectUri,
    scope: 'repo:status',
    state: uuid.v4()
  });

  res.header('Location', authorization_uri);
  res.send(302);
  return next();
};

Server.prototype.callback = function(req, res, next) {
  var _this = this;

  this.getAccessToken(req.params.code, function(err, accessToken) {
    if (err) {
      res.send(500, err.message);
    } else {
      _this.lookupCommits(accessToken, function(err, ghData) {
        if (err) {
          res.send(500, err.message);
        } else {
          res.header('Location', '/');
          res.send(302);
        }
      });
    }
    return next();
  });
};

Server.prototype.getAccessToken = function(code, cb) {
  var _this = this;

  this.oauth2.authCode.getToken({
    code: code,
    redirect_uri: this.redirectUri
  }, function(err, result) {
    if (err) return cb(err);

    var accessToken = querystring.parse(_this.oauth2.accessToken.create(result).token).access_token;
    cb(null, accessToken);
  });
};

Server.prototype.lookupCommits = function(token, cb) {
  var _this = this,
    gitHubCommits = new GitHubCommits(token);

  // lookup the logged in username.
  github.authenticate({type: 'oauth', token: token});
  github.user.get({}, function(err, user) {
    if (err) return cb(err);

    // actually lookup the user's commits.
    gitHubCommits.forUser(user.login)
      .commitsSince("2014-01-01T23:59:59Z")
      .toArray(function(repositories){
        var ghData = {
          user: user.login,
          commits: 0
        };

        repositories.forEach(function(r) {
          ghData.commits += (r.commitCount || 0);
        });

        return _this.storeUserData(ghData, cb);
      });
  });
};

Server.prototype.storeUserData = function(ghData, cb) {
  this.redis.set(ghData.user, ghData.commits, function(err) {
    return cb(err);
  });
};

Server.prototype.start = function() {
  server.listen(process.env.PORT, function () {
    console.log('%s listening at %s', server.name, server.url);
  });
};

Server.prototype.stats = function(req, res, next) {
  var _this = this,
    stats = [];

  this.redis.keys('*', function(err, keys) {
    if (err) {
      res.send(500, err.message);
    } else {
      async.each(keys, function(key, done) {
        _this.redis.get(key, function(err, count) {
          stats.push({
            name: key,
            commits: parseInt(count)
          })
          return done();
        });
      }, function() {
        stats.sort(function(a, b) {
          return a.commits < b.commits;
        });
        res.send(200, stats);
      })
    }
    return next();
  });
};

(new Server()).start();
