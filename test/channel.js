// Test the channel model API

var assert = require('assert');
var defer = require('when').defer;
var Channel = require('../lib/channel').Channel;
var Connection = require('../lib/connection').Connection;
var util = require('./util');
var succeed = util.succeed, fail = util.fail, latch = util.latch;
var completes = util.completes;
var defs = require('../lib/defs');
var conn_handshake = require('./connection').connection_handshake;
var OPEN_OPTS = require('./connection').OPEN_OPTS;

var LOG_ERRORS = process.env.LOG_ERRORS;

function baseChannelTest(client, server) {
  return function(done) {
    var bothDone = latch(2, done);
    var pair = util.socketPair();
    var c = new Connection(pair.client);
    if (LOG_ERRORS) c.on('error', console.warn);
    c.open(OPEN_OPTS).then(function() {
      client(c, bothDone);
    }, fail(bothDone));

    pair.server.read(8); // discard the protocol header
    var s = util.runServer(pair.server, function(send, await) {
      conn_handshake(send, await)
        .then(function() {
          server(send, await, bothDone);
        }, fail(bothDone));
    });
  };
}

function channelTest(client, server) {
  return baseChannelTest(
    function(conn, done) {
      var ch = new Channel(conn);
      if (LOG_ERRORS) ch.on('error', console.warn);
      client(ch, done);
    },
    function(send, await, done) {
      channel_handshake(send, await)
      .then(function(ch) {
        return server(send, await, done, ch);
      }).then(null, fail(done)); // so you can return a promise to let
                                 // errors bubble out
    }
  );
};

function channel_handshake(send, await) {
  return await(defs.ChannelOpen)()
    .then(function(open) {
      assert.notEqual(0, open.channel);
      send(defs.ChannelOpenOk, {channelId: new Buffer('')}, open.channel);
      return open.channel;
    });
}

// fields for deliver and publish and get-ok
var DELIVER_FIELDS = {
  consumerTag: 'fake',
  deliveryTag: 1,
  redelivered: false,
  exchange: 'foo',
  routingKey: 'bar',
  replyCode: defs.constants.NO_ROUTE,
  replyText: 'derp',
};

suite("channel open and close", function() {

test("open", channelTest(
  function(ch, done) {
    ch.open().then(succeed(done), fail(done));
  },
  function(send, await, done) {
    done();
  }));

test("bad server", baseChannelTest(
  function(c, done) {
    var ch = new Channel(c);
    ch.open().then(fail(done), succeed(done));
  },
  function(send, await, done) {
    return await(defs.ChannelOpen)()
      .then(function(open) {
        send(defs.ChannelCloseOk, {}, open.channel);
      }).then(succeed(done), fail(done));
  }));

test("open, close", channelTest(
  function(ch, done) {
    ch.open()
      .then(function() {
        ch.close();
      })
      .then(succeed(done), fail(done));
  },
  function(send, await, done, ch) {
    return await(defs.ChannelClose)()
      .then(function(close) {
        send(defs.ChannelCloseOk, {}, ch);
      }).then(succeed(done), fail(done));;
  }));

test("server close", channelTest(
  function(ch, done) {
    ch.on('error', succeed(done));
    ch.open();
  },
  function(send, await, done, ch) {
    send(defs.ChannelClose, {
      replyText: 'Forced close',
      replyCode: defs.constants.CHANNEL_ERROR,
      classId: 0, methodId: 0
    }, ch);
    await(defs.ChannelCloseOk)()
      .then(succeed(done), fail(done));
  }));

}); //suite

suite("channel machinery", function() {

test("RPC", channelTest(
  function(ch, done) {
    ch.open().then(function() {
      var rpcLatch = latch(3, done);
      var whee = succeed(rpcLatch);
      var boom = fail(rpcLatch);
      var fields = {
        prefetchCount: 10,
        prefetchSize: 0,
        global: false
      };
      
      ch.rpc(defs.BasicQos, fields, defs.BasicQosOk).then(whee, boom);
      ch.rpc(defs.BasicQos, fields, defs.BasicQosOk).then(whee, boom);
      ch.rpc(defs.BasicQos, fields, defs.BasicQosOk).then(whee, boom);
    }).then(null, fail(rpcLatch));
  },
  function(send, await, done, ch) {
    function sendOk(f) {
      send(defs.BasicQosOk, {}, ch);
    }

    return await(defs.BasicQos)()
      .then(sendOk)
      .then(await(defs.BasicQos))
      .then(sendOk)
      .then(await(defs.BasicQos))
      .then(sendOk)
      .then(succeed(done), fail(done));
  }));

test("Bad RPC", channelTest(
  function(ch, done) {
    // We want to see the RPC rejected and the channel closed (with an
    // error)
    var errLatch = latch(2, done);
    ch.on('error', succeed(errLatch));
    
    ch.open()
      .then(function() {
        ch.rpc(defs.BasicRecover, {requeue: true}, defs.BasicRecoverOk)
          .then(fail(done), succeed(errLatch));
      }, fail(errLatch));
  },
  function(send, await, done, ch) {
    return await()()
      .then(function() {
        send(defs.BasicGetEmpty, {clusterId: ''}, ch);
      }) // oh wait! that was wrong! expect a channel close
      .then(await(defs.ChannelClose))
      .then(function() {
        send(defs.ChannelCloseOk, {}, ch);
      }).then(succeed(done), fail(done));
  }));

test("RPC on closed channel", channelTest(
  function(ch, done) {
    ch.open();
    var close = defer(), fail1 = defer(), fail2 = defer();
    ch.on('error', close.resolve);
    ch.rpc(defs.BasicRecover, {requeue:true}, defs.BasicRecoverOk)
      .then(fail1.reject, fail1.resolve);
    ch.rpc(defs.BasicRecover, {requeue:true}, defs.BasicRecoverOk)
      .then(fail2.reject, fail2.resolve);

    close.promise
      .then(function(){ return fail1.promise; })
      .then(function() { return fail2.promise; })
      .then(succeed(done), fail(done));
  },
  function(send, await, done, ch) {
    await(defs.BasicRecover)()
      .then(function() {
        send(defs.ChannelClose, {
          replyText: 'Nuh-uh!',
          replyCode: defs.constants.CHANNEL_ERROR,
          methodId: 0, classId: 0
        }, ch);
        return await(defs.ChannelCloseOk);
      })
      .then(succeed(done), fail(done));
  }));

test("publish", channelTest(
  function(ch, done) {
    ch.open()
      .then(function() {
        ch.sendMessage({
          exchange: 'foo', routingKey: 'bar',
          mandatory: false, immediate: false, ticket: 0
        }, {}, new Buffer('foobar'));
      })
      .then(succeed(done), fail(done));
  },
  function(send, await, done, ch) {
    await(defs.BasicPublish)()
      .then(await(defs.BasicProperties))
      .then(await(undefined)) // content frame
      .then(function(f) {
        assert.equal('foobar', f.content.toString());
      }).then(succeed(done), fail(done));
  }));

test("delivery", channelTest(
  function(ch, done) {
    ch.open();
    ch.on('delivery', function(m) {
      completes(function() {
        assert.equal('barfoo', m.content.toString());
      }, done);
    });
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicDeliver, DELIVER_FIELDS, ch, new Buffer('barfoo'));
    }, done);
  }));

test("zero byte msg = no content body frames", channelTest(
  function(ch, done) {
    ch.open();
    ch.on('delivery', function(m) {
      completes(function() {
        assert.deepEqual(new Buffer(0), m.content);
      }, done);
    });
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicDeliver, DELIVER_FIELDS, ch, new Buffer(''));
    }, done);
  }));

test("bad delivery", channelTest(
  function(ch, done) {
    errorAndClose = latch(2, done);
    ch.on('error', succeed(errorAndClose));
    ch.on('close', succeed(errorAndClose));
    ch.open();
  },
  function(send, await, done, ch) {
    send(defs.BasicDeliver, DELIVER_FIELDS, ch);
    // now send another deliver without having sent the content
    send(defs.BasicDeliver, DELIVER_FIELDS, ch);
    return await(defs.ChannelClose)()
      .then(function() {
        send(defs.ChannelCloseOk, {}, ch);
      }).then(succeed(done), fail(done));
  }));

test("bad content send", channelTest(
  function(ch, done) {
    completes(function() {
      ch.open();
      assert.throws(function() {
        ch.sendMessage({routingKey: 'foo',
                        exchange: 'amq.direct'},
                       {}, null);
      });
    }, done);
  },
  function(send, await, done, ch) {
    done();
  }));

test("bad properties send", channelTest(
  function(ch, done) {
    completes(function() {
      ch.open();
      assert.throws(function() {
        ch.sendMessage({routingKey: 'foo',
                        exchange: 'amq.direct'},
                       {contentEncoding: 7},
                       new Buffer('foobar'));
      });
    }, done);
  },
  function(send, await, done, ch) {
    done();
  }));  

test("bad consumer", channelTest(
  function(ch, done) {
    errorAndClose = latch(2, done);
    ch.on('delivery', function() {
      throw new Error("I am a bad consumer");
    });
    ch.on('error', succeed(errorAndClose));
    ch.on('close', succeed(errorAndClose));
    ch.open();
  },
  function(send, await, done, ch) {
    send(defs.BasicDeliver, DELIVER_FIELDS, ch, new Buffer('barfoo'));
    return await(defs.ChannelClose)()
      .then(function() {
        send(defs.ChannelCloseOk, {}, ch);
      }).then(succeed(done), fail(done));
  }));

test("bad send in consumer", channelTest(
  function(ch, done) {
    var errorAndClose = latch(2, done);
    ch.on('close', succeed(errorAndClose));
    ch.on('error', succeed(errorAndClose));

    ch.on('delivery', function() {
      ch.sendMessage({routingKey: 'foo',
                      exchange: 'amq.direct'},
                     {}, null); // can't send null
    });

    ch.open();
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicDeliver, DELIVER_FIELDS, ch,
           new Buffer('barfoo'));
    }, done);
    return await(defs.ChannelClose)()
      .then(function() {
        send(defs.ChannelCloseOk, {}, ch);
      }).then(succeed(done), fail(done));
  }));

test("return", channelTest(
  function(ch, done) {
    ch.on('return', function(m) {
      completes(function() {
        assert.equal('barfoo', m.content.toString());
      }, done);
    });
    ch.open();
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicReturn, DELIVER_FIELDS, ch, new Buffer('barfoo'));
    }, done);
  }));

test("cancel", channelTest(
  function(ch, done) {
    ch.on('cancel', function(f) {
      completes(function() {
        assert.equal('product of society', f.consumerTag);
      }, done);
    });
    ch.open();
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicCancel, {
        consumerTag: 'product of society',
        nowait: false
      }, ch);
    }, done);
  }));

function confirmTest(variety, Method) {
  return test('confirm ' + variety, channelTest(
    function(ch, done) {
      ch.on(variety, function(f) {
        completes(function() {
          assert.equal(1, f.deliveryTag);
        }, done);
      });
      ch.open();
    },
    function(send, await, done, ch) {
      completes(function() {
        send(Method, {
          deliveryTag: 1,
          multiple: false
        }, ch);
      }, done);
    }));
}

confirmTest("ack", defs.BasicAck);
confirmTest("nack", defs.BasicNack);

test("out-of-order acks", channelTest(
  function(ch, done) {
    var allConfirms = latch(3, function() {
      completes(function() {
        assert.equal(0, ch.unconfirmed.length);
        assert.equal(4, ch.lwm);
      }, done);
    });
    ch.pushConfirmCallback(allConfirms);
    ch.pushConfirmCallback(allConfirms);
    ch.pushConfirmCallback(allConfirms);
    ch.open();
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicAck, {deliveryTag: 2, multiple: false}, ch);
      send(defs.BasicAck, {deliveryTag: 3, multiple: false}, ch);
      send(defs.BasicAck, {deliveryTag: 1, multiple: false}, ch);
    }, done);
  }));

test("not all out-of-order acks", channelTest(
  function(ch, done) {
    var allConfirms = latch(2, function() {
      completes(function() {
        assert.equal(1, ch.unconfirmed.length);
        assert.equal(3, ch.lwm);
      }, done);
    });
    ch.pushConfirmCallback(allConfirms); // tag = 1
    ch.pushConfirmCallback(allConfirms); // tag = 2
    ch.pushConfirmCallback(function() {
      done(new Error('Confirm callback should not be called'));
    });
    ch.open();
  },
  function(send, await, done, ch) {
    completes(function() {
      send(defs.BasicAck, {deliveryTag: 2, multiple: false}, ch);
      send(defs.BasicAck, {deliveryTag: 1, multiple: false}, ch);
    }, done);
  }));

});
