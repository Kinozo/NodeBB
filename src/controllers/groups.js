"use strict";

var groups = require('../groups'),
	async = require('async'),
	nconf = require('nconf'),
	groupsController = {};

groupsController.list = function(req, res) {
	groups.list({
		truncateUserList: true,
		expand: true
	}, function(err, groups) {
		res.render('groups/list', {
			groups: groups
		});
	});
};

groupsController.details = function(req, res) {
	var uid = req.user ? parseInt(req.user.uid, 10) : 0;

	async.parallel({
		isMemberOfGroup: function (next)
		{
			groups.isMember(uid, req.params.name, next);
		},
		group: function(next) {
			groups.get(req.params.name, {
				expand: true
			}, next);
		},
		posts: function(next) {
			groups.getLatestMemberPosts(req.params.name, 10, uid, next);
		}
	}, function(err, results) {
		if (!err)
		{
			if (!results.isMemberOfGroup || req.params.name == "administrators" || req.params.name == "registered-users")
			{
				res.redirect(nconf.get('relative_path') + '/403');
			}
			else
			{
				res.render('groups/details', results);
			}	
		}
		else
		{
			res.redirect(nconf.get('relative_path') + '/404');
		}
	});
};

module.exports = groupsController;
