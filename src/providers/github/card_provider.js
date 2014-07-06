var li = require('li');
var async = require('async');
var info = require('./info');

var _ = {
  map: require('lodash.map'),
  where: require('lodash.where')
}

var Endpoint = require('../../client/endpoint');

module.exports = function(board, linker, token, $http) {
  var api = new Endpoint();
  api.setRoot('https://api.github.com/');
  api.setClient('angular', $http, {
    headers: { 'Authorization': 'token '+token }
  });

  var user = null;

  return {
    info: info,
    next: function() {
      linker._Provider = this;
      linker._Help = "Loading user metadata ...";
      api.get('user').success(function(data) {
        user = data;
        linker._Help = "Is it a personal repository or part of an organization?"
        linker._PersonalOrOrg = true;
      })
    },
    personal: function() {
      linker._PersonalOrOrg = false;
      this.repoScope = this.info.displayName+'/'+user.login;
      this.getRepos(user.repos_url);
    },
    org: function() {
      linker._PersonalOrOrg = false;
      linker._Help = "Fetching organizations...";
      api.get(user.organizations_url).success(function(data) {
        linker._Help = "Which organization owns the repository from which you wish to import open issues?";
        linker._Orgs = data;
      })
    },
    selectOrg: function(org) {
      linker._Orgs = false;
      this.getRepos(org.repos_url);
    },
    getReposPrev: function() {
      this.getRepos(linker._ReposLinks.prev);
    },
    getReposNext: function() {
      this.getRepos(linker._ReposLinks.next);
    },
    getRepos: function(url) {
      linker._Help = "Fetching repositories...";
      linker._Repos = [];
      linker.fetchedAllRepos = false;
      this.getMoreRepos(url+"?per_page=100");
    },
    getMoreRepos: function(url) {
      api.get(url).success(function(data, status, headers, config) {
        linker._Repos = linker._Repos.concat(data);
        var next = headers('Link') ? li.parse(headers('Link')).next : null;
        if (next) {
          this.getMoreRepos(next);
        } else {
          linker.fetchedAllRepos = true;
          linker._Help = "Choose one or more repositories to link with the board.";
        }
      }.bind(this))
    },
    importWantedRepos: function() {
      var ids = linker._WantedReposIds;
      var allRepos = linker._Repos;
      var repos = _.map(ids, function (id) {
        return _.where(allRepos, { id: parseInt(id) })[0];
      });

      this.linkRepos(repos, function (err) {
        if (err) {
          throw new Error(err);
        } else {
          linker.close();
        }
      });
    },
    linkRepos: function (repos, callback) {
      var self = this;
      var url = api.route('boards/'+board._id+'/links/'+this.info.name);
      var linkObject = {};
      linkObject[this.info.name] = repos;
      api.put(url, linkObject).success(function(data) {
        if (data.links) {
          board.links = data.links;
          logger.info("Linked "+repos.length+" repos");
          async.each(repos, function (repo, callback2) {
            logger.info("Importing issues and installing webhook for "+repo.id);
            self.importRepoIssues(repo, function (err) {
              if (err) { callback2(err) } 
              else {
                self.installWebhook(repo, function () {
                  if (err) { callback2(err) } 
                  else { callback2(null) }
                });
              }
            });
          }, function (err) {
            if (err) 
              callback(err);
            else
              callback(null);
          });
        } else {
          callback(new Error("Repo did not link"))
        }
      }).error(function (err) {
        callback(err);
      });
    },
    installWebhook: function(repo, done) {
      // https://developer.github.com/v3/repos/hooks/#create-a-hook
      api.post(repo.hooks_url, {
        // full list here: https://api.github.com/hooks
        name: "web",
        active: true,
        // more info about events here: https://developer.github.com/webhooks/#events
        events: [
          "issue_comment",
          "issues"
        ],
        config: {
          url: api.route('boards/'+board._id+'/github/'+repo.id+'/webhook'),
          content_type: "json"
        }
      }).success(function () {
        done(null)
      }).error(function (err) {
        done(err)
      });
    },
    importRepoIssues: function(repo, done) {
      repo.imported = true;
      var url = repo.issues_url.replace('{/number}','')+'?per_page=100&state=open';
      this.importIssues(url, { repo_id: repo.id }, done);
    },
    importIssues: function(url, metadata, done) {
      api.get(url).success(function(data, status, headers) {
        this.postIssues(data, metadata);
        var next = headers('Link') ? li.parse(headers('Link')).next : null;
        if (next) {
          this.importIssues(next, metadata, done);
        } else {
          done(null);
        }
      }.bind(this)).error(done);
    },
    postIssues: function(openIssues, metadata) {
      var importUrl = api.route('boards/'+board._id+'/cards/github');
      api.post(importUrl, {
        metadata: metadata,
        openIssues: openIssues
      }).success(function(data) {
        if (data.board)
          board.columns = data.board.columns;
      });
    },
    canImport: function(repo) {
      return repo.has_issues && repo.open_issues_count > 0;
    }
  }
};
