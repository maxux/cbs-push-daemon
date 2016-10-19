var apn = require('apn');
var mysql = require('mysql');
var express = require('express');
var bodyParser = require('body-parser');
var cbsRouter = require('./cbs-routing.js');
var redis = require("redis")

//
// global production variable
//
var productionapp = true;

console.log('[+] initializing')

if(!productionapp) {
	console.log("[!]")
	console.log("[!] initializing debug environment")
	console.log("[!]")
}

var apnscert  = productionapp ? 'certificates/cbs-push-prod.pem' : 'certificates/cbs-push.pem';
var apnskey   = productionapp ? 'certificates/cbs-push-prod.pem' : 'certificates/cbs-push.pem';
var sqldb     = productionapp ? 'cbseraing' : 'cbseraing-debug';
var redischan = productionapp ? 'cbs-push' : 'cbs-push-debug';
var webport   = productionapp ? 45887 : 45880;

//
// Apple Notifications
//
var options = {
	cert: apnscert,
	key: apnskey,
	passphrase: '',
	batchFeedback: true,
    interval: 20,
    production: productionapp,
};

console.log('[+] connecting push server (' + apnscert + ')')
var apnConnection = new apn.Connection(options);

console.log('[+] connecting to feedback service')
var feedback = new apn.Feedback(options);

feedback.on("feedback", function(devices) {
	devices.forEach(function(item) {
		console.log(item);
	});
});


//
// MySQL
//
var sql = mysql.createConnection({
	host: '',
	user: '',
	password: '',
	database: sqldb,
});

console.log('[+] connecting mysql server')
sql.connect();

setInterval(function() {
	sql.ping(function (err) {
		if (err) throw err;
		console.log('[+] mysql still alive');
	})

}, 180 * 1000);

//
// Web Server
//
var app = express();
var routes = new cbsRouter(sql, apnConnection);

app.use(bodyParser.urlencoded({extended: true}));

app.post('/api/login', routes.login);
app.post('/api/devices/register', routes.newdevice);
app.post('/api/debug', routes.debug);

console.log('[+] starting web server')
app.listen(webport);

//
// Redis
//
var reclient = redis.createClient();

reclient.on("error", function (err) {
	console.log("[-] redis: " + err);
});

reclient.on("message", function (channel, message) {
	console.log("[+] redis channel [" + channel + "]: " + message);
	
	var data = JSON.parse(message);
	routes.notification(data.event, data.uid, data.subject, data.category);
});

reclient.subscribe("cbs-push");

console.log('[+] daemon is ready')
