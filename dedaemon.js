#!/usr/bin/env node

var syscheck = require("./js/syscheck");
var parseConf = require("./js/parse-conf");
var async = require("./js/async");
var udev = require("./udev");

var execSync = require("child_process").execSync
var spawnSync = require("child_process").spawnSync
var fs = require("fs");

var modules = {
	display: require("./modules/display"),
	input: require("./modules/input"),
	wallpaper: require("./modules/wallpaper"),
	process: require("./modules/process"),
};

if (!process.argv[2]) {
	console.error("Usage:", process.argv[1], "<config file>");
	console.error("      ", process.argv[1], "list   -- List display and input devices");
	console.error("      ", process.argv[1], "reload -- Reload the running dedaemon instance");
	console.error("      ", process.argv[1], "stop   -- Stop all running dedaemon instances");
	process.exit(1);
}

var config;

var fatalError = false;
function createLogger(name) {
	function log(pre, msg) {
		var str = pre+msg.join(" ");

		console.error(str);
		try {
			fs.appendFileSync(config.general.log, str+"\n");
		} catch (err) {
			if (!fatalError) {
				fatalError = true;
				console.error("FATAL: Failed to write to log file!!");
				console.error(err.toString());
				stopAll(() => {
					process.exit(1);
				});
			}
		};
	}

	return {
		info: (...msg) => log(name+": INFO: ", msg),
		warn: (...msg) => log(name+": WARNING: ", msg),
		error: (...msg) => log(name+": ERROR: ", msg),
	}
}

var logger = createLogger("dedaemon");

function startAll() {
	try {
		fs.renameSync(config.general.log, config.general.log+".old");
	} catch (err) {}
	fs.writeFileSync(config.general.log, "");

	Object.keys(modules).forEach(i => {
		var mod = modules[i];
		var conf = config[i];
		mod.running = false;

		if (conf instanceof Array && conf.length === 0)
			return;
		if (!conf)
			return;

		mod.running = true;
		mod.start(conf, createLogger(i), modules);
	});
}

function stopAll(cb) {
	var keys = Object.keys(modules);
	var next = async(keys.length, cb);
	keys.forEach(i => {
		if (modules[i].running) {
			modules[i].stop(next);
			modules[i].running = false;
		} else {
			next();
		}
	});
}

function onTerm() {
	logger.info("Exiting...");
	stopAll(() => {
		udev.exit();
		logger.info("All modules stopped.");
		process.exit(1)
	});
}

function reload() {
	try {
		config = parseConf(process.argv[2]);
	} catch (err) {
		logger.error(
			"Tried to reload, but parsing the config file failed:",
			err.toString());
		return;
	}
	logger.info("Reloading.");

	stopAll(() => {
		startAll();
	});
}

function killRunningDaemon(signal, once, waitConfirm) {
	var cmd =
		"pgrep -a node | "+
		"grep dedaemon | "+
		"grep -ve stop -e reload | "+
		"cut -d' ' -f1";

	var out = execSync(cmd)
		.toString();

	var lines = out.split("\n").filter(l => l !== "");
	if (lines.length > 1 && once) {
		console.error("There are multiple dedaemon processes running.");
		process.exit(1);
	}
	if (lines.length === 0) {
		console.error("No dedaemon process is running.");
		process.exit(1);
	}

	lines.forEach(line => {
		spawnSync("kill", [ "-s", signal,  line ]);
		console.error("Sent", "SIG"+signal, "to process", line);
	});

	if (!waitConfirm)
		return;

	var exists;
	do {
		exists = false;
		lines.forEach(line => {
			var res = spawnSync("kill", [ "-0", line ]);
			if (res.status === 0)
				exists = true;
		});

		if (exists)
			spawnSync("sleep", [ "0.2" ]);
	} while (exists);
}

if (process.argv[2] === "list") {
	udev.init();
	console.error("display:");
	modules.display.list(() => {
		console.error("input:");
		modules.input.list(() => {
			udev.exit();
			process.exit(0);
		});
	});
} else if (process.argv[2] === "reload") {
	killRunningDaemon("USR1", true);
	process.exit(0);
} else if (process.argv[2] === "stop") {
	killRunningDaemon("TERM", false, true);
	process.exit(0);
} else {
	udev.init();
	var config = parseConf(process.argv[2]);

	syscheck(ok => {
		if (ok) {
			startAll();
		} else {
			console.error("Missing binaries, exiting.");
			process.exit(1);
		}
	});

	process.on("SIGTERM", onTerm);
	process.on("SIGINT", onTerm);
	process.on("SIGUSR1", reload);
}
