"use strict";

var	async = require('async'),
	nconf = require('nconf'),

	db = require('../database'),
	posts = require('../posts'),
	privileges = require('../privileges'),
	meta = require('../meta'),
	topics = require('../topics'),
	favourites = require('../favourites'),
	postTools = require('../postTools'),
	notifications = require('../notifications'),
	groups = require('../groups'),
	user = require('../user'),
	websockets = require('./index'),

	SocketPosts = {};


SocketPosts.reply = function(socket, data, callback) {
	if(!data || !data.tid || !data.content) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	data.uid = socket.uid;
	data.req = websockets.reqFromSocket(socket);

	topics.reply(data, function(err, postData) {
		if(err) {
			return callback(err);
		}

		if (postData) {
			var privileges = {
				'topics:reply': true
			};

			websockets.server.sockets.emit('event:new_post', {
				posts: [postData],
				privileges: privileges,
				'reputation:disabled': parseInt(meta.config['reputation:disabled'], 10) === 1,
				'downvote:disabled': parseInt(meta.config['downvote:disabled'], 10) === 1,
			});

			module.parent.exports.emitTopicPostStats();
			topics.pushUnreadCount();

			callback();
		}
	});
};

SocketPosts.upvote = function(socket, data, callback) {
	if (!data || !data.pid) {
		return callback(new Error('[[error:invalid-data]]'));
	}
	favouriteCommand('upvote', 'voted', socket, data, callback);
	SocketPosts.sendNotificationToPostOwner(data.pid, socket.uid, 'notifications:upvoted_your_post');
};

SocketPosts.downvote = function(socket, data, callback) {
	favouriteCommand('downvote', 'voted', socket, data, callback);
};

SocketPosts.unvote = function(socket, data, callback) {
	favouriteCommand('unvote', 'voted', socket, data, callback);
};

SocketPosts.favourite = function(socket, data, callback) {
	if (!data || !data.pid) {
		return callback(new Error('[[error:invalid-data]]'));
	}
	favouriteCommand('favourite', 'favourited', socket, data, callback);
	SocketPosts.sendNotificationToPostOwner(data.pid, socket.uid, 'notifications:favourited_your_post');
};

SocketPosts.unfavourite = function(socket, data, callback) {
	favouriteCommand('unfavourite', 'favourited', socket, data, callback);
};

function favouriteCommand(command, eventName, socket, data, callback) {
	if(data && data.pid && data.room_id) {
		favourites[command](data.pid, socket.uid, function(err, result) {
			if (err) {
				return callback(err);
			}

			socket.emit('posts.' + command, result);

			if(data.room_id && result && eventName) {
				websockets.in(data.room_id).emit('event:' + eventName, result);
			}
			callback();
		});
	}
}

SocketPosts.sendNotificationToPostOwner = function(pid, fromuid, notification) {
	if(!pid || !fromuid) {
		return;
	}
	posts.getPostFields(pid, ['tid', 'uid'], function(err, postData) {
		if (err) {
			return;
		}

		if (fromuid === parseInt(postData.uid, 10)) {
			return;
		}

		async.parallel({
			username: async.apply(user.getUserField, fromuid, 'username'),
			postContent: function(next) {
				async.waterfall([
					async.apply(posts.getPostField, pid, 'content'),
					function(content, next) {
						postTools.parse(content, next);
					}
				], next);
			}
		}, function(err, results) {
			if (err) {
				return;
			}

			notifications.create({
				bodyShort: '[[' + notification + ', ' + results.username + ']]',
				bodyLong: results.postContent,
				pid: pid,
				uniqueId: 'post:' + pid + ':uid:' + fromuid,
				from: fromuid
			}, function(err, nid) {
				if (!err) {
					notifications.push(nid, [postData.uid]);
				}
			});
		});
	});
};

SocketPosts.getRawPost = function(socket, pid, callback) {
	async.waterfall([
		function(next) {
			privileges.posts.can('read', pid, socket.uid, next);
		},
		function(canRead, next) {
			if (!canRead) {
				return next(new Error('[[error:no-privileges]]'));
			}
			posts.getPostFields(pid, ['content', 'deleted'], next);
		},
		function(postData, next) {
			if (parseInt(postData.deleted, 10) === 1) {
				return next(new Error('[[error:no-post]]'));
			}
			next(null, postData.content);
		}
	], callback);
};

SocketPosts.edit = function(socket, data, callback) {
	if(!socket.uid) {
		return callback(new Error('[[error:not-logged-in]]'));
	} else if(!data || !data.pid || !data.title || !data.content) {
		return callback(new Error('[[error:invalid-data]]'));
	} else if (!data.title || data.title.length < parseInt(meta.config.minimumTitleLength, 10)) {
		return callback(new Error('[[error:title-too-short, ' + meta.config.minimumTitleLength + ']]'));
	} else if (data.title.length > parseInt(meta.config.maximumTitleLength, 10)) {
		return callback(new Error('[[error:title-too-long, ' + meta.config.maximumTitleLength + ']]'));
	} else if (!data.content || data.content.length < parseInt(meta.config.minimumPostLength, 10)) {
		return callback(new Error('[[error:content-too-short, ' + meta.config.minimumPostLength + ']]'));
	}

	postTools.edit(socket.uid, data.pid, data.title, data.content, {topic_thumb: data.topic_thumb, tags: data.tags}, function(err, results) {
		if(err) {
			return callback(err);
		}

		websockets.server.sockets.in('topic_' + results.topic.tid).emit('event:post_edited', {
			pid: data.pid,
			title: results.topic.title,
			isMainPost: results.topic.isMainPost,
			tags: results.topic.tags,
			content: results.content
		});

		callback();
	});
};

SocketPosts.delete = function(socket, data, callback) {
	deleteOrRestore('delete', socket, data, callback);
};

SocketPosts.restore = function(socket, data, callback) {
	deleteOrRestore('restore', socket, data, callback);
};

function deleteOrRestore(command, socket, data, callback) {
	if(!data) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	postTools[command](socket.uid, data.pid, function(err, postData) {
		if(err) {
			return callback(err);
		}

		module.parent.exports.emitTopicPostStats();

		var eventName = command === 'restore' ? 'event:post_restored' : 'event:post_deleted';
		websockets.server.sockets.in('topic_' + data.tid).emit(eventName, postData);

		callback();
	});
}

SocketPosts.purge = function(socket, data, callback) {
	if(!data) {
		return callback(new Error('[[error:invalid-data]]'));
	}
	postTools.purge(socket.uid, data.pid, function(err) {
		if(err) {
			return callback(err);
		}

		module.parent.exports.emitTopicPostStats();

		websockets.server.sockets.in('topic_' + data.tid).emit('event:post_purged', data.pid);

		callback();
	});
};

SocketPosts.getPrivileges = function(socket, pid, callback) {
	privileges.posts.get([pid], socket.uid, function(err, privileges) {
		if (err) {
			return callback(err);
		}
		if (!Array.isArray(privileges) || !privileges.length) {
			return callback(new Error('[[error:invalid-data]]'));
		}

		privileges[0].pid = parseInt(pid, 10);
		callback(null, privileges[0]);
	});
};

SocketPosts.getFavouritedUsers = function(socket, pid, callback) {
	favourites.getFavouritedUidsByPids([pid], function(err, data) {
		if (err || !Array.isArray(data) || !data.length) {
			return callback(err);
		}

		user.getUsernamesByUids(data[0], callback);
	});
};

SocketPosts.getUpvoters = function(socket, pid, callback) {
	favourites.getUpvotedUidsByPids([pid], function(err, data) {
		if (err || !Array.isArray(data) || !data.length) {
			return callback(err, []);
		}

		user.getUsernamesByUids(data[0], callback);
	});
};

SocketPosts.flag = function(socket, pid, callback) {
	if (!socket.uid) {
		return callback(new Error('[[error:not-logged-in]]'));
	}

	var message = '',
		post;

	async.waterfall([
		function(next) {
			user.getUserFields(socket.uid, ['username', 'reputation'], next);
		},
		function(userData, next) {
			if (parseInt(userData.reputation, 10) < parseInt(meta.config['privileges:flag'] || 1, 10)) {
				return next(new Error('[[error:not-enough-reputation-to-flag]]'));
			}
			message = '[[notifications:user_flagged_post, ' + userData.username + ']]';
			posts.getPostFields(pid, ['tid', 'uid', 'content'], next);
		},
		function(postData, next) {
			postTools.parse(postData.content, function(err, parsed) {
				if (err) {
					return next(err);
				}
				postData.content = parsed;
				next(null, postData);
			});
		},
		function(postData, next) {
			post = postData;
			groups.get('administrators', {}, next);
		},
		function(adminGroup, next) {
			notifications.create({
				bodyShort: message,
				bodyLong: post.content,
				pid: pid,
				uniqueId: 'post_flag:' + pid,
				from: socket.uid
			}, function(err, nid) {
				if (err) {
					return next(err);
				}
				notifications.push(nid, adminGroup.members, next);
			});
		},
		function(next) {
			if (!parseInt(post.uid, 10)) {
				return next();
			}

			db.setAdd('uid:' + post.uid + ':flagged_by', socket.uid, function(err) {
				if (err) {
					return next(err);
				}
				db.setCount('uid:' + post.uid + ':flagged_by', function(err, count) {
					if (err) {
						return next(err);
					}

					if (count >= (meta.config.flagsForBan || 3) && parseInt(meta.config.flagsForBan, 10) !== 0) {
						var adminUser = require('./admin/user');
						adminUser.banUser(post.uid, next);
						return;
					}
					next();
				});
			});
		}
	], callback);
};

SocketPosts.loadMoreFavourites = function(socket, data, callback) {
	if(!data || !data.after) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 9;

	posts.getFavourites(socket.uid, start, end, callback);
};

SocketPosts.loadMoreUserPosts = function(socket, data, callback) {
	if(!data || !data.after || !data.uid) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 9;

	posts.getPostsByUid(socket.uid, data.uid, start, end, callback);
};


SocketPosts.getRecentPosts = function(socket, data, callback) {
	if(!data || !data.count) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	posts.getRecentPosts(socket.uid, 0, data.count - 1, data.term, callback);
};

SocketPosts.getCategory = function(socket, pid, callback) {
	posts.getCidByPid(pid, callback);
};

SocketPosts.getPidIndex = function(socket, pid, callback) {
	posts.getPidIndex(pid, socket.uid, callback);
};

module.exports = SocketPosts;
