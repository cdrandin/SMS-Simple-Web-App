const SCWorker = require('socketcluster/scworker');
const express = require('express');
const serveStatic = require('serve-static');
const path = require('path');
const morgan = require('morgan');
const healthChecker = require('sc-framework-health-check');
const bcrypt = require('bcrypt');
const knexHooks = require('knex-hooks');
const knex = require('knex')({
    client: 'sqlite3',
    connection: {
        filename: 'db.sqlite'
    },
    'pool': {
        'min': 2,
        'max': 10
    },
    useNullAsDefault: true
});
knexHooks(knex);

const BCRYPT_WORK_FACTOR_BASE = 12;
const BCRYPT_DATE_BASE = 1483228800000;
const BCRYPT_WORK_INCREASE_INTERVAL = 47300000000;
const BCRYPT_CURRENT_DATE = new Date().getTime();
const BCRYPT_WORK_INCREASE = Math.max(0, Math.floor((BCRYPT_CURRENT_DATE - BCRYPT_DATE_BASE) / BCRYPT_WORK_INCREASE_INTERVAL));
const BCRYPT_WORK_FACTOR = Math.min(19, BCRYPT_WORK_FACTOR_BASE + BCRYPT_WORK_INCREASE);
const salt = bcrypt.genSaltSync(BCRYPT_WORK_FACTOR);

knex.schema.hasTable('users').then(function(exists) {
    if (!exists) {
        return knex.schema.createTable('users', function(table) {
            table.increments().primary();
            table.string('username');
            table.string('password');
            table.string('channel');
        });
    }
});

knex.addHook('after', 'insert', 'users', (when, method, table, params) => {
    const data = knexHooks.helpers.getInsertData(params.query);
    const passwordHash = bcrypt.hashSync(data.password, salt);
    knex(table).where({username: data.username}).update({
        password: passwordHash,
        channel: bcrypt.hashSync(`${data.username}${passwordHash}`, salt)
    }).then(() => {});
});

knex('users').select().where({username: 'cdrandin'}).then(function(rows) {
    if (rows.length === 0) {
        knex('users').insert({username: 'cdrandin', password: 'lolinternet'}).then(() => {});
    }
}).catch(console.log);

class Worker extends SCWorker {
    run() {
        console.log('   >> Worker PID:', process.pid);
        const environment = this.options.environment;

        const app = express();

        const httpServer = this.httpServer;
        const scServer = this.scServer;

        if (environment === 'dev') {
            // Log every HTTP request. See https://github.com/expressjs/morgan for other
            // available formats.
            app.use(morgan('dev'));
        }
        app.use(serveStatic(path.resolve(__dirname, 'public')));

        // Add GET /health-check express route
        healthChecker.attach(this, app);

        httpServer.on('request', app);

        let count = 0;

        scServer.addMiddleware(scServer.MIDDLEWARE_PUBLISH_IN, function(req, next) {
            var authToken = req.socket.authToken;
            console.log(authToken.channels);
            console.log(req);
            if (authToken/* && authToken.channels.indexOf(req.channel) > -1 */) {
                // console.log(`${authToken.channels}_text`);
                // socket.on(`${authToken.channels}_text`, function(data, res) {
                //     console.log(`Data: ${data}`);
                // });
                next();
            } else {
                next('Incorrect credentials');
            }
        });

        scServer.on('connection', function(socket) {
            // Some sample logic to show how to handle client events,
            // replace this with your own logic
            // socket.on('sampleClientEvent', function(data) {
            //     count++;
            //     console.log('Handled sampleClientEvent', data);
            //     scServer.exchange.publish('sample', count);
            // });

            // const interval = setInterval(function() {
            //     socket.emit('random', {
            //         number: Math.floor(Math.random() * 5)
            //     });
            // }, 1000);

            // socket.on('disconnect', function() {
            //     clearInterval(interval);
            // });

            socket.on('login', function(credentials, respond) {
                if (credentials && credentials.username && credentials.password) {
                    console.log('verifying input...');
                    // const hash = bcrypt.hashSync(credentials.password, salt);
                    knex('users').where('username', credentials.username).then((users) => {
                        if (users) {
                            const user = users[0];
                            console.log(user);
                            if (bcrypt.compareSync(credentials.password, user.password)) {
                                const channelHash = bcrypt.hashSync(`${user.username}${user.password}`, salt);
                                socket.setAuthToken({username: credentials.username, channels: user.channel});
                                respond(null, user.channel);
                                socket.on(user.channel, function(data, res) {
                                    console.log(`${user.username}'s private channel'`);
                                    res(null, 'hello world');
                                });

                            } else {
                                respond('Incorrect username or password');
                            }
                        }
                    });
                } else {
                    respond('Incorrect data sent');
                }
            });

            socket.on('ping', function(data) {
                count++;
                console.log('PING', data);
                scServer.exchange.publish('pong', count);
            });

        });
    }
}

new Worker();
