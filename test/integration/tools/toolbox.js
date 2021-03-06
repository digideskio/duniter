"use strict";

const Q           = require('q');
const _           = require('underscore');
const co          = require('co');
const rp          = require('request-promise');
const httpTest    = require('../tools/http');
const sync        = require('../tools/sync');
const commit      = require('../tools/commit');
const user        = require('../tools/user');
const until       = require('../tools/until');
const Peer        = require('../../../app/lib/entity/peer');
const Identity    = require('../../../app/lib/entity/identity');
const Block       = require('../../../app/lib/entity/block');
const bma         = require('../../../app/lib/streams/bma');
const multicaster = require('../../../app/lib/streams/multicaster');
const network     = require('../../../app/lib/system/network');
const dtos        = require('../../../app/lib/streams/dtos');
const duniter     = require('../../../index');

const MEMORY_MODE = true;
const CURRENCY_NAME = 'duniter_unit_test_currency';
const HOST = '127.0.0.1';
let PORT = 10000;

module.exports = {

  simpleNetworkOf2NodesAnd2Users: (options) => co(function*() {
    const catKeyring = { pub: 'HgTTJLAQ5sqfknMq7yLPZbehtuLSsKj9CxWN7k8QvYJd', sec: '51w4fEShBk1jCMauWu4mLpmDVfHksKmWcygpxriqCEZizbtERA6de4STKRkQBpxmMUwsKXRjSzuQ8ECwmqN1u2DP'};
    const tacKeyring = { pub: '2LvDg21dVXvetTD9GdkPLURavLYEqP3whauvPWX4c2qc', sec: '2HuRLWgKgED1bVio1tdpeXrf7zuUszv1yPHDsDj7kcMC4rVSN9RC58ogjtKNfTbH1eFz7rn38U1PywNs3m6Q7UxE'};

    const s1 = module.exports.server(_.extend({ pair: catKeyring }, options || {}));
    const s2 = module.exports.server(_.extend({ pair: tacKeyring }, options || {}));

    const cat = user('cat', catKeyring, { server: s1 });
    const tac = user('tac', tacKeyring, { server: s1 });

    yield s1.initWithDAL().then(bma).then((bmapi) => bmapi.openConnections());
    yield s2.initWithDAL().then(bma).then((bmapi) => bmapi.openConnections());

    yield s2.sharePeeringWith(s1);
    // yield s2.post('/network/peering/peers', yield s1.get('/network/peering'));
    // yield s1.submitPeerP(yield s2.get('/network/peering'));

    yield cat.createIdentity();
    yield tac.createIdentity();
    yield cat.cert(tac);
    yield tac.cert(cat);
    yield cat.join();
    yield tac.join();

    // Each server forwards to each other
    s1.pipe(s1.router()).pipe(multicaster());
    s2.pipe(s2.router()).pipe(multicaster());

    return { s1, s2, cat, tac };
  }),

  simpleNodeWith2Users: (options) => co(function*() {

    const catKeyring = { pub: 'HgTTJLAQ5sqfknMq7yLPZbehtuLSsKj9CxWN7k8QvYJd', sec: '51w4fEShBk1jCMauWu4mLpmDVfHksKmWcygpxriqCEZizbtERA6de4STKRkQBpxmMUwsKXRjSzuQ8ECwmqN1u2DP'};
    const tacKeyring = { pub: '2LvDg21dVXvetTD9GdkPLURavLYEqP3whauvPWX4c2qc', sec: '2HuRLWgKgED1bVio1tdpeXrf7zuUszv1yPHDsDj7kcMC4rVSN9RC58ogjtKNfTbH1eFz7rn38U1PywNs3m6Q7UxE'};

    const s1 = module.exports.server(_.extend({ pair: catKeyring }, options || {}));

    const cat = user('cat', catKeyring, { server: s1 });
    const tac = user('tac', tacKeyring, { server: s1 });

    yield s1.initWithDAL().then(bma).then((bmapi) => bmapi.openConnections());

    yield cat.createIdentity();
    yield tac.createIdentity();
    yield cat.cert(tac);
    yield tac.cert(cat);
    yield cat.join();
    yield tac.join();

    return { s1, cat, tac };
  }),

  fakeSyncServer: (readBlocksMethod, readParticularBlockMethod, onPeersRequested) => {

    const host = HOST;
    const port = PORT++;

    return co(function*() {

      // Meaningful variables
      const NO_HTTP_LOGS = false;
      const NO_STATIC_PATH = null;

      // A fake HTTP limiter with no limit at all
      const noLimit = {
        canAnswerNow: () => true,
        processRequest: () => { /* Does nothing */ }
      };

      const fakeServer = yield network.createServersAndListen("Fake Duniter Server", [{
        ip: host,
        port: port
      }], NO_HTTP_LOGS, NO_STATIC_PATH, (app, httpMethods) => {

        // Mock BMA method for sync mocking
        httpMethods.httpGET('/network/peering', () => {
          return co(function*() {
            return {
              endpoints: [['BASIC_MERKLED_API', host, port].join(' ')]
            }
          });
        }, dtos.Peer, noLimit);

        // Mock BMA method for sync mocking
        httpMethods.httpGET('/network/peering/peers', onPeersRequested, dtos.MerkleOfPeers, noLimit);

        // Another mock BMA method for sync mocking
        httpMethods.httpGET('/blockchain/blocks/:count/:from', (req) => {

          // What do we do on /blockchain/blocks request
          let count = parseInt(req.params.count);
          let from = parseInt(req.params.from);

          return readBlocksMethod(count, from);

        }, dtos.Blocks, noLimit);

        // Another mock BMA method for sync mocking
        httpMethods.httpGET('/blockchain/block/:number', (req) => {

          // What do we do on /blockchain/blocks request
          let number = parseInt(req.params.number);

          return readParticularBlockMethod(number);

        }, dtos.Block, noLimit);
      });

      yield fakeServer.openConnections();
      return {
        host: host,
        port: port
      };
    });
  },

  /**
   * Creates a new memory duniter server for Unit Test purposes.
   * @param conf
   */
  server: (conf) => {
    const port = PORT++;
    const commonConf = {
      port: port,
      ipv4: HOST,
      remoteipv4: HOST,
      currency: conf.currency || CURRENCY_NAME,
      httpLogs: true,
      forksize: 3,
      parcatipate: false, // TODO: to remove when startGeneration will be an explicit call
      sigQty: 1
    };
    const server = duniter({
      memory: conf.memory !== undefined ? conf.memory : MEMORY_MODE,
      name: conf.homename || 'dev_unit_tests'
    }, _.extend(conf, commonConf));

    server.port = port;
    server.host = HOST;

    server.url = (uri) => 'http://' + [HOST, port].join(':') + uri;
    server.get = (uri) => rp(server.url(uri), { json: true });
    server.post = (uri, obj) => rp(server.url(uri), { method: 'POST', json: true, body: obj });

    server.expect = (uri, expectations) => typeof expectations == 'function' ? httpTest.expectAnswer(rp(server.url(uri), { json: true }), expectations) : httpTest.expectJSON(rp(server.url(uri), { json: true }), expectations);
    server.expectThat = (uri, expectations) => httpTest.expectAnswer(rp(server.url(uri), { json: true }), expectations);
    server.expectJSON = (uri, expectations) => httpTest.expectJSON(rp(server.url(uri), { json: true }), expectations);

    server.syncFrom = (otherServer, fromIncuded, toIncluded) => sync(fromIncuded, toIncluded, otherServer, server);

    server.until = (type, count) => until(server, type, count);

    server.commit = (options) => co(function*() {
      const raw = yield commit(server)(options);
      return JSON.parse(raw);
    });

    server.commitExpectError = (options) => co(function*() {
      try {
        const raw = yield commit(server)(options);
        JSON.parse(raw);
        throw { message: 'Commit operation should have thrown an error' };
      } catch (e) {
        if (e.statusCode) {
          throw JSON.parse(e.error);
        }
      }
    });

    server.lookup2identity = (search) => co(function*() {
      const lookup = yield server.get('/wot/lookup/' + search);
      return Identity.statics.fromJSON({
        issuer: lookup.results[0].pubkey,
        currency: conf.currency,
        uid: lookup.results[0].uids[0].uid,
        buid: lookup.results[0].uids[0].meta.timestamp,
        sig: lookup.results[0].uids[0].self
      });
    });

    server.readBlock = (number) => co(function*() {
      const block = yield server.get('/blockchain/block/' + number);
      return Block.statics.fromJSON(block);
    });

    server.makeNext = (overrideProps) => co(function*() {
      const block = yield server.doMakeNextBlock(overrideProps || {});
      return Block.statics.fromJSON(block);
    });

    server.sharePeeringWith = (otherServer) => co(function*() {
      let p = yield server.get('/network/peering');
      yield otherServer.post('/network/peering/peers', {
        peer: Peer.statics.peerize(p).getRawSigned()
      });
    });

    server.postIdentity = (idty) => server.post('/wot/add', {
      identity: idty.createIdentity()
    });

    server.postCert = (cert) => server.post('/wot/certify', {
      cert: cert.getRaw()
    });

    server.postMembership = (ms) => server.post('/blockchain/membership', {
      membership: ms.getRawSigned()
    });

    server.postRevocation = (rev) => server.post('/wot/revoke', {
      revocation: rev.getRaw()
    });

    server.postBlock = (block) => server.post('/blockchain/block', {
      block: block.getRawSigned()
    });

    server.postRawTX = (rawTX) => server.post('/tx/process', {
      transaction: rawTX
    });

    server.postPeer = (peer) => server.post('/network/peering/peers', {
      peer: peer.getRawSigned()
    });

    server.prepareForNetwork = () => co(function*() {
      yield server.initWithDAL();
      const bmaAPI = yield bma(server);
      yield bmaAPI.openConnections();
      server.bma = bmaAPI;
      server
        .pipe(server.router()) // The router asks for multicasting of documents
        .pipe(multicaster())
        .pipe(server.router());
      return server.start();
    });

    return server;
  }
};
