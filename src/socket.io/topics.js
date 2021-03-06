
'use strict';

var nconf = require('nconf'),
	async = require('async'),

	topics = require('../topics'),
	categories = require('../categories'),
	privileges = require('../privileges'),
	notifications = require('../notifications'),
	threadTools = require('../threadTools'),
	websockets = require('./index'),
	user = require('../user'),
	db = require('../database'),
	meta = require('../meta'),
	utils = require('../../public/src/utils'),
	SocketPosts = require('./posts'),

	SocketTopics = {};

SocketTopics.post = function(socket, data, callback) {

	if(!data) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	topics.post({
		uid: socket.uid,
		title: data.title,
		content: data.content,
		cid: data.category_id,
		thumb: data.topic_thumb,
		tags: data.tags,
		req: websockets.reqFromSocket(socket)
	}, function(err, result) {
		if(err) {
			return callback(err);
		}

		if (result) {

			websockets.server.sockets.in('category_' + data.category_id).emit('event:new_topic', result.topicData);
			websockets.server.sockets.in('recent_posts').emit('event:new_topic', result.topicData);
			websockets.server.sockets.in('home').emit('event:new_topic', result.topicData);
			websockets.server.sockets.in('home').emit('event:new_post', {
				posts: result.postData
			});
			websockets.server.sockets.in('user/' + socket.uid).emit('event:new_post', {
				posts: result.postData
			});

			module.parent.exports.emitTopicPostStats();
			topics.pushUnreadCount();

			callback(null, result.topicData);
		}
	});
};

SocketTopics.enter = function(socket, tid, callback) {
	if (!tid || !socket.uid) {
		return;
	}
	SocketTopics.markAsRead(socket, tid);
	topics.markTopicNotificationsRead(tid, socket.uid);
	topics.increaseViewCount(tid);
};

SocketTopics.postcount = function(socket, tid, callback) {
	topics.getTopicField(tid, 'postcount', callback);
};

SocketTopics.increaseViewCount = function(socket, tid) {
	topics.increaseViewCount(tid);
};

SocketTopics.markAsRead = function(socket, tid) {
	if(!tid || !socket.uid) {
		return;
	}

	topics.markAsRead(tid, socket.uid, function(err) {
		topics.pushUnreadCount(socket.uid);
	});
};

SocketTopics.markTidsRead = function(socket, tids, callback) {
	if (!Array.isArray(tids)) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	topics.markTidsRead(socket.uid, tids, function(err) {
		if(err) {
			return callback(err);
		}

		topics.pushUnreadCount(socket.uid);

		for (var i=0; i<tids.length; ++i) {
			topics.markTopicNotificationsRead(tids[i], socket.uid);
		}

		callback();
	});
};

SocketTopics.markTopicNotificationsRead = function(socket, tid, callback) {
	if(!tid || !socket.uid) {
		return callback(new Error('[[error:invalid-data]]'));
	}
	topics.markTopicNotificationsRead(tid, socket.uid);
};

SocketTopics.markAllRead = function(socket, data, callback) {
	topics.getUnreadTids(socket.uid, 0, -1, function(err, tids) {
		if (err) {
			return callback(err);
		}

		SocketTopics.markTidsRead(socket, tids, callback);
	});
};

SocketTopics.markCategoryTopicsRead = function(socket, cid, callback) {
	topics.getUnreadTids(socket.uid, 0, -1, function(err, tids) {
		if (err) {
			return callback(err);
		}

		var keys = tids.map(function(tid) {
			return 'topic:' + tid;
		});

		db.getObjectsFields(keys, ['tid', 'cid'], function(err, topicData) {
			if (err) {
				return callback(err);
			}

			tids = topicData.filter(function(topic) {
				return parseInt(topic.cid, 10) === parseInt(cid, 10);
			}).map(function(topic) {
				return topic.tid;
			});

			SocketTopics.markTidsRead(socket, tids, callback);
		});

	});
};

SocketTopics.markAsUnreadForAll = function(socket, tids, callback) {
	if (!Array.isArray(tids)) {
		return callback(new Error('[[error:invalid-tid]]'));
	}

	if (!socket.uid) {
		return callback(new Error('[[error:no-privileges]]'));
	}

	user.isAdministrator(socket.uid, function(err, isAdmin) {
		if (err) {
			return callback(err);
		}

		async.each(tids, function(tid, next) {
			async.waterfall([
				function(next) {
					threadTools.exists(tid, next);
				},
				function(exists, next) {
					if (!exists) {
						return next(new Error('[[error:invalid-tid]]'));
					}
					topics.getTopicField(tid, 'cid', next);
				},
				function(cid, next) {
					user.isModerator(socket.uid, cid, next);
				}
			], function(err, isMod) {
				if (err) {
					return next(err);
				}

				if (!isAdmin && !isMod) {
					return next(new Error('[[error:no-privileges]]'));
				}

				topics.markAsUnreadForAll(tid, function(err) {
					if(err) {
						return next(err);
					}

					db.sortedSetAdd('topics:recent', Date.now(), tid, function(err) {
						if(err) {
							return next(err);
						}
						topics.pushUnreadCount();
						next();
					});
				});
			});
		}, callback);
	});
};

SocketTopics.delete = function(socket, data, callback) {
	doTopicAction('delete', socket, data, callback);
};

SocketTopics.restore = function(socket, data, callback) {
	doTopicAction('restore', socket, data, callback);
};

SocketTopics.purge = function(socket, data, callback) {
	doTopicAction('purge', socket, data, function(err) {
		if (err) {
			return callback(err);
		}
		websockets.emitTopicPostStats();
		websockets.in('category_' + data.cid).emit('event:topic_purged', data.tids);
		async.each(data.tids, function(tid, next) {
			websockets.in('topic_' + tid).emit('event:topic_purged', tid);
			next();
		}, callback);
	});
};

SocketTopics.lock = function(socket, data, callback) {
	doTopicAction('lock', socket, data, callback);
};

SocketTopics.unlock = function(socket, data, callback) {
	doTopicAction('unlock', socket, data, callback);
};

SocketTopics.pin = function(socket, data, callback) {
	doTopicAction('pin', socket, data, callback);
};

SocketTopics.unpin = function(socket, data, callback) {
	doTopicAction('unpin', socket, data, callback);
};

function doTopicAction(action, socket, data, callback) {
	if(!data || !Array.isArray(data.tids) || !data.cid) {
		return callback(new Error('[[error:invalid-tid]]'));
	}

	async.each(data.tids, function(tid, next) {
		privileges.topics.canEdit(tid, socket.uid, function(err, canEdit) {
			if(err) {
				return next(err);
			}

			if(!canEdit) {
				return next(new Error('[[error:no-privileges]]'));
			}

			if(typeof threadTools[action] === 'function') {
				threadTools[action](tid, socket.uid, next);
			}
		});
	}, callback);
}

SocketTopics.createTopicFromPosts = function(socket, data, callback) {
	if(!socket.uid) {
		return callback(new Error('[[error:not-logged-in]]'));
	}

	if(!data || !data.title || !data.pids || !Array.isArray(data.pids)) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	topics.createTopicFromPosts(socket.uid, data.title, data.pids, callback);
};

SocketTopics.movePost = function(socket, data, callback) {
	if (!socket.uid) {
		return callback(new Error('[[error:not-logged-in]]'));
	}

	if (!data || !data.pid || !data.tid) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	privileges.posts.canMove(data.pid, socket.uid, function(err, canMove) {
		if (err || !canMove) {
			return callback(err || new Error('[[error:no-privileges]]'));
		}

		topics.movePostToTopic(data.pid, data.tid, function(err) {
			if (err) {
				return callback(err);
			}

			SocketPosts.sendNotificationToPostOwner(data.pid, socket.uid, 'notifications:moved_your_post');
			callback();
		});
	});
};

SocketTopics.move = function(socket, data, callback) {
	if(!data || !Array.isArray(data.tids) || !data.cid) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	async.eachLimit(data.tids, 10, function(tid, next) {
		var oldCid;
		async.waterfall([
			function(next) {
				privileges.topics.canMove(tid, socket.uid, next);
			},
			function(canMove, next) {
				if (!canMove) {
					return next(new Error('[[error:no-privileges]]'));
				}
				next();
			},
			function(next) {
				topics.getTopicField(tid, 'cid', next);
			},
			function(cid, next) {
				oldCid = cid;
				threadTools.move(tid, data.cid, socket.uid, next);
			}
		], function(err) {
			if(err) {
				return next(err);
			}

			websockets.server.sockets.in('topic_' + tid).emit('event:topic_moved', {
				tid: tid
			});

			websockets.server.sockets.in('category_' + oldCid).emit('event:topic_moved', {
				tid: tid
			});

			SocketTopics.sendNotificationToTopicOwner(tid, socket.uid, 'notifications:moved_your_topic');

			next();
		});
	}, callback);
};


SocketTopics.sendNotificationToTopicOwner = function(tid, fromuid, notification) {
	if(!tid || !fromuid) {
		return;
	}

	async.parallel({
		username: async.apply(user.getUserField, fromuid, 'username'),
		topicData: async.apply(topics.getTopicFields, tid, ['uid', 'slug']),
	}, function(err, results) {
		if (err || fromuid === parseInt(results.topicData.uid, 10)) {
			return;
		}

		notifications.create({
			bodyShort: '[[' + notification + ', ' + results.username + ']]',
			path: nconf.get('relative_path') + '/topic/' + results.topicData.slug,
			uniqueId: 'topic:' + tid + ':uid:' + fromuid,
			from: fromuid
		}, function(err, nid) {
			if (!err) {
				notifications.push(nid, [results.topicData.uid]);
			}
		});
	});
};


SocketTopics.moveAll = function(socket, data, callback) {
	if(!data || !data.cid || !data.currentCid) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	privileges.categories.canMoveAllTopics(data.currentCid, data.cid, data.uid, function(err, canMove) {
		if (err || canMove) {
			return callback(err || new Error('[[error:no-privileges]]'));
		}

		categories.getTopicIds(data.currentCid, 0, -1, function(err, tids) {
			if (err) {
				return callback(err);
			}

			async.eachLimit(tids, 10, function(tid, next) {
				threadTools.move(tid, data.cid, socket.uid, next);
			}, callback);
		});
	});
};

SocketTopics.followCheck = function(socket, tid, callback) {
	topics.isFollowing(tid, socket.uid, callback);
};

SocketTopics.follow = function(socket, tid, callback) {
	if(!socket.uid) {
		return callback(new Error('[[error:not-logged-in]]'));
	}

	threadTools.toggleFollow(tid, socket.uid, callback);
};

SocketTopics.loadMore = function(socket, data, callback) {
	if(!data || !data.tid || !(parseInt(data.after, 10) >= 0))  {
		return callback(new Error('[[error:invalid-data]]'));
	}

	async.parallel({
		settings: function(next) {
			user.getSettings(socket.uid, next);
		},
		privileges: function(next) {
			privileges.topics.get(data.tid, socket.uid, next);
		},
		postCount: function(next) {
			topics.getPostCount(data.tid, next);
		}
	}, function(err, results) {
		if (err) {
			return callback(err);
		}

		if (!results.privileges.read) {
			return callback(new Error('[[error:no-privileges]]'));
		}

		var set = 'tid:' + data.tid + ':posts',
			reverse = false,
			start = Math.max(parseInt(data.after, 10) - 1, 0);

		if (results.settings.topicPostSort === 'newest_to_oldest') {
			reverse = true;
			data.after = results.postCount - data.after;
			start = Math.max(parseInt(data.after, 10), 0);
		} else if (results.settings.topicPostSort === 'most_votes') {
			reverse = true;
			data.after = results.postCount - data.after;
			start = Math.max(parseInt(data.after, 10), 0);
			set = 'tid:' + data.tid + ':posts:votes';
		}

		var end = start + results.settings.postsPerPage - 1;

		async.parallel({
			posts: function(next) {
				topics.getTopicPosts(data.tid, set, start, end, socket.uid, reverse, next);
			},
			privileges: function(next) {
				next(null, results.privileges);
			},
			'reputation:disabled': function(next) {
				next(null, parseInt(meta.config['reputation:disabled'], 10) === 1);
			}
		}, callback);
	});
};

SocketTopics.loadMoreRecentTopics = function(socket, data, callback) {
	if(!data || !data.term || !data.after) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 9;

	topics.getLatestTopics(socket.uid, start, end, data.term, callback);
};

SocketTopics.loadMoreUnreadTopics = function(socket, data, callback) {
	if(!data || !data.after) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 9;

	topics.getUnreadTopics(socket.uid, start, end, callback);
};

SocketTopics.loadMoreFromSet = function(socket, data, callback) {
	if(!data || !data.after || !data.set) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 9;

	topics.getTopicsFromSet(socket.uid, data.set, start, end, callback);
};

SocketTopics.loadTopics = function(socket, data, callback) {
	if(!data || !data.set || !utils.isNumber(data.start) || !utils.isNumber(data.end)) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	topics.getTopicsFromSet(socket.uid, data.set, data.start, data.end, callback);
};

SocketTopics.getPageCount = function(socket, tid, callback) {
	topics.getPageCount(tid, socket.uid, callback);
};

SocketTopics.getTidPage = function(socket, tid, callback) {
	topics.getTidPage(tid, socket.uid, callback);
};

SocketTopics.getTidIndex = function(socket, tid, callback) {
	categories.getTopicIndex(tid, callback);
};

SocketTopics.searchTags = function(socket, data, callback) {
	topics.searchTags(data, callback);
};

SocketTopics.search = function(socket, data, callback) {
	topics.search(data.tid, data.term, callback);
};

SocketTopics.searchAndLoadTags = function(socket, data, callback) {
	topics.searchTags(data, function(err, tags) {
		if (err) {
			return callback(err);
		}
		async.parallel({
			counts: function(next) {
				db.sortedSetScores('tags:topic:count', tags, next);
			},
			tagData: function(next) {
				tags = tags.map(function(tag) {
					return {value: tag};
				});

				topics.getTagData(tags, next);
			}
		}, function(err, results) {
			if (err) {
				return callback(err);
			}
			results.tagData.forEach(function(tag, index) {
				tag.score = results.counts[index];
			});
			results.tagData.sort(function(a, b) {
				return parseInt(b.score, 10) - parseInt(a.score, 10);
			});

			callback(null, results.tagData);
		});
	});
};

SocketTopics.loadMoreTags = function(socket, data, callback) {
	if(!data || !data.after) {
		return callback(new Error('[[error:invalid-data]]'));
	}

	var start = parseInt(data.after, 10),
		end = start + 99;

	topics.getTags(start, end, function(err, tags) {
		if (err) {
			return callback(err);
		}

		callback(null, {tags: tags, nextStart: end + 1});
	});
};

module.exports = SocketTopics;
