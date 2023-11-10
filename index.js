const Hapi = require('@hapi/hapi')
const PouchDB = require('pouchdb');
PouchDB.plugin(require('pouchdb-find'));
const longpoll = 10 * 1000 // 10 seconds
const maxWait = 10 * 1000 // 10 seconds
const longpolls = {}
const waitingForUsers = {}

const init = async () => {

  // Setup

  const DBURL = "http://127.0.0.1:5984/kanbangaroo"
  const db = new PouchDB(DBURL, {
    auth: {
      username: "admin",
      password: "admin",
    },
  })
  await db.createIndex({
    index: { fields: ['lockedBy'] }
  });
  await db.createIndex({
    index: { fields: ['type'] }
  });

  async function clearStaleOnlineUsers() {
    const users = await db.find({
      selector: {
        type: 'onlineUser'
      }
    });
    let deletedUsers = [...users.docs]
    deletedUsers = deletedUsers.map(user => {
      return {...user, _deleted: true}

    })
    await db.bulkDocs(deletedUsers)
  }

  async function deleteLocks(username) {
    const locks = await db.find({
      selector: {
        lockedBy: username
      }
    });
    let docsToDelete = locks.docs.map(lock => {
      return { ...lock, _deleted: true }
    })
    let onlineuserDoc
    try {
      onlineuserDoc = await db.get(`onlineuser-${username}`)
      docsToDelete = [...docsToDelete, { ...onlineuserDoc, _deleted: true }]
    } catch (error) {
      console.log(`No userdoc found for ${username}`)
    }
    if (docsToDelete.length > 0) {
      try {
        const lockDeleteResponse = await db.bulkDocs(docsToDelete)
        console.log(`Delete response for ${username}:`, lockDeleteResponse)
      } catch (error) {
        console.log(`Could not delete ${username}’s locks:`, error)
      }
    } else {
      console.log(`Nothing to be deleted for ${username}`)
    }
  }

  const server = Hapi.server({
    port: 8000,
    host: 'localhost'
  });

  async function waitForReturn(username) {
    console.log(`Longpoll elapsed, waiting for ${username} to return…`)
    clearTimeout(waitingForUsers[username])
    delete waitingForUsers[username]
    waitingForUsers[username] = setTimeout(() => {
      console.log(`${username} did not to return in time, deleting their locks.`)
      deleteLocks(username)
      delete waitingForUsers[username]
    }, maxWait);
  }

  async function process(username, h) {
    if (waitingForUsers[username]) {
      console.log(`${username} is still there, yay.`)
      clearTimeout(waitingForUsers[username])
      delete waitingForUsers[username]
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(h.response(`Hello ${username}!`));
      }, longpoll);
    });
  }

  server.route({
    options: {
      cors: {
        origin: ['http://localhost:5173']
      }
    },
    method: 'GET',
    path: '/onlineuser',
    async handler(request, h) {
      const username = request.query.username || 0
      console.log(`${username} is polling.`)
      request.events.on('disconnect', () => {
        console.log(`${username}’s request was aborted, deleting their locks.`)
        deleteLocks(username)
        clearTimeout(waitingForUsers[username])
        delete waitingForUsers[username]
        clearTimeout(longpolls[username])
        delete longpolls[username]
      });
      longpolls[username] = await process(username, h)
      waitForReturn(username)
      return longpolls[username]
    }
  })

  await clearStaleOnlineUsers()

  await server.start();
  console.log('🦘 Kanbangaroo Server running on %s', server.info.uri);
};

process.on('unhandledRejection', (err) => {
  console.log(err);
  process.exit(1);
});

init();
