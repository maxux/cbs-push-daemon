var express = require('express');
var bodyParser = require('body-parser');
var crypto = require('crypto');
var apn = require('apn');

//
// helpers
//
function md5(string) {
	return crypto.createHash('md5').update(string).digest('hex');
}

function sha1(string) {
	return crypto.createHash('md5').update(string).digest('hex');
}

function invalid(root, message) {
	var struct = {
		'status': 'error',
		'payload': message
	};
	
	return root.res.end(JSON.stringify(struct) + "\n");
}

function success(root, message) {
	var struct = {
		'status': 'success',
		'payload': message
	};
	
	return root.res.end(JSON.stringify(struct) + "\n");
}

function tokenizer(sql, uid) {
	var token = sha1(new Date() + Math.random() + 'lulz');
	console.log('[+] token generated: ' + token);
	
	sql.query({
		sql: 'INSERT INTO cbs_tokens (uid, token) VALUES (?, ?)',
		values: [uid, token]
		
	}, function (error, results, fields) { if (error) throw error; });
	
	return token;
}

function checkToken(root, callback) {
	root.sql.query({
		sql: 'SELECT uid FROM cbs_tokens WHERE token = ?',
		values: [root.token]
		
	}, function (error, results, fields) {
		if (error) throw error;
		
		if(results.length == 0) {
			console.log('[-] token not authorized');
			return invalid(root, {'message': 'token not authorized'});
		}
		
		callback(root, results[0].uid);
	});
}

//
// notifier
// MOVE ME
//
function notifier(apnLink, token, data) {
	var device = new apn.Device(token);
	var note = new apn.Notification();

	note.expiry = Math.floor(Date.now() / 1000) + (86400 * 30);
	note.badge = 0;
	note.sound = "ping.aiff";
	note.alert = data['title'];
	note.payload = {'messageFrom': 'Maxux'};
	
	console.log('[+] sending notification to: ' + token);
	apnLink.pushNotification(note, device);
}

function forward(sql, apnLink, category, message) {
	var self = this;
	
	self.apnLink = apnLink;
	
	// select who access this category
	sql.query({
		sql: 'SELECT n.* FROM cbs_notifications n, cbs_membres m, cbs_forum_acl f ' +
		     'WHERE m.type = f.tid AND n.uid = m.id AND f.cid = ?',
		values: [category]
		
	}, function (error, results, fields) {
		if (error) throw error;
		
		if(results.length == 0) {
			console.log('[-] forward: no devices found');
			return;
		}
		
		for(var i in results) {
			var notif = results[i];
			notifier(self.apnLink, notif.device, {title: message});
		}
		
		return;
	});
}

//
// routing process
//
var CbsWebRouting = function(sql, apnLink) {
	console.log('[+] loading routes');
	
	var sql = sql;
	var apnLink = apnLink;
	
	var routing = {
		login: {
			error: {'message': 'invalid login'},
		}
	}
	
	//
	// login request, validation and token generator
	//
	this.login = function(req, res) {
		var self = this
		
		self.res = res
		self.login = req.body.login
		self.passwd = req.body.password
		
		console.log('[+] api: login from: ' + self.login)
		
		sql.query({
			sql: 'SELECT id uid, code FROM cbs_membres WHERE email = ?',
			values: [login]
			
		}, function (error, results, fields) {
			if (error) throw error;
			
			if(results.length != 1) {
				console.log('[-] api: login not found');
				return invalid(self, routing.login.error);
			}
			
			var hash = md5(self.passwd)
			
			if(results[0].code == hash) {
				var user = {
					uid: results[0].uid,
					token: tokenizer(sql, results[0].uid)
				};
				
				return success(self, user);
				
			} else {
				console.log('[-] api: password mismatch');
				return invalid(self, routing.login.error);
			}
		});
	}
	
	//
	// register new device
	//
	this.newdevice = function(req, res) {
		var self = this
		
		self.res = res
		self.token = req.body.token
		self.device = req.body.device
		self.sql = sql
		
		console.log('[+] api: device registration (token: ' + self.token + ')')
		checkToken(self, insertdevice);
	}
	
	function insertdevice(root, uid) {
		console.log('[+] adding device: [' + uid + ']: ' + root.device);
		
		root.sql.query({
			sql: 'INSERT INTO cbs_notifications (uid, device) VALUES (?, ?)',
			values: [uid, root.device]
			
		}, function (error, results, fields) { if (error) console.log(error); });
		
		return success(root, {'message': 'device added'});
	}
	
	//
	// receive a notification
	//
	this.notification = function(event, user, subject, category) {
		if(event == 'subject')
			newsubject(user, subject, category);
		
		if(event == 'reply')
			newreply(user, subject, category);
	}
	
	function newsubject(user, subject, category) {
		var self = this;
		
		self.apnLink = apnLink;
		self.sql = sql;
		
		sql.query({
			sql: 'SELECT * FROM cbs_membres WHERE id = ?',
			values: [user]
			
		}, function (error, results, fields) {
			if (error) throw error;
			
			if(results.length != 1) {
				console.log('[-] newsubject: user not found');
				return;
			}
			
			var user = results[0];
			var name = (user.surnom == '') ? user.nomreel : user.surnom;
			
			var content = name + ' a posté un nouveau sujet: ' + subject;
			forward(self.sql, self.apnLink, category, content);
		});
	}
	
	function newreply(user, subject, category) {
		// discard if it's the first message
		// reply event is fired when a new subject is created
		var self = this;
		
		self.apnLink = apnLink;
		self.sql = sql;
		self.subject = subject;

		sql.query({
			sql: 'SELECT * FROM cbs_membres WHERE id = ?',
			values: [user]
			
		}, function (error, results, fields) {
			if (error) throw error;
			
			if(results.length != 1) {
				console.log('[-] reply-member: user not found');
				return;
			}
			
			var user = results[0];
			var name = (user.surnom == '') ? user.nomreel : user.surnom;
			
			self.sql.query({
				sql: 'SELECT s.subject, COUNT(*) total FROM cbs_forum_subjects s, cbs_forum_messages m ' +
				     'WHERE m.subject = s.id AND s.id = ? GROUP BY s.subject',
				values: [self.subject]
				
			}, function (error, results, fields) {
				if (error) throw error;
				
				if(results.length != 1) {
					console.log('[-] reply-subject: subject not found');
					return;
				}
				
				var topic = results[0];
				
				if(topic.total < 2) {
					console.log('[-] reply-subject: not a reply, skipping');
					return;
				}
				
				var content = name + ' a répondu au sujet: ' + topic.subject;
				forward(self.sql, self.apnLink, category, content);
			});
		});
	}
	
	//
	// debug
	//
	this.debug = function(req, res) {
		var self = this;
		
		self.res = res;
		self.uid = req.body.uid;
		self.sql = sql;
		self.apnLink = apnLink;
		
		console.log('[+] api: debug')
		
		root.sql.query({
			sql: 'SELECT * FROM cbs_notifications -- WHERE uid = ?',
			// values: [self.uid]
			
		}, function (error, results, fields) {
			if (error) throw error;
			
			if(results.length == 0) {
				console.log('[-] no devices found');
				return invalid(self, {'message': 'no devices found'});
			}
			
			for(var i in results) {
				var notif = results[i];
				notifier(self.apnLink, notif.device, {title: 'Nouvelle notification'});
			}
			
			return success(self, {'message': 'notifications sent'});
		});
	}
}

module.exports = CbsWebRouting;
