const torrentStream = require('torrent-stream')
const http = require('http')
const fs = require('fs')
const rangeParser = require('range-parser')
const xtend = require('xtend')
const url = require('url')
const mime = require('mime')
const pump = require('pump')

const parseBlocklist = function (filename) {
  // TODO: support gzipped files
  const blocklistData = fs.readFileSync(filename, { encoding: 'utf8' })
  const blocklist = []
  blocklistData.split('\n').forEach(function (line) {
    let match = null
    if ((match = /^\s*[^#].*?\s*:\s*([a-f0-9.:]+?)\s*-\s*([a-f0-9.:]+?)\s*$/.exec(line))) {
      blocklist.push({
        start: match[1],
        end: match[2]
      })
    }
  })
  return blocklist
}

const truthy = function () {
  return true
}

const createServer = function (e, opts) {
  const server = http.createServer()
  let index = opts.index
  const getType = opts.type || mime.getType.bind(mime)
  const filter = opts.filter || truthy

  const onready = function () {
    if (typeof index !== 'number') {
      index = e.files.reduce(function (a, b) {
        return a.length > b.length ? a : b
      })
      index = e.files.indexOf(index)
    }

    e.files[index].select()
    server.index = e.files[index]

    if (opts.sort) e.files.sort(opts.sort)
  }

  if (e.torrent) onready()
  else e.on('ready', onready)

  server.on('request', function (request, response) {
    const u = url.parse(request.url)
    const host = request.headers.host || 'localhost'

    const toPlaylist = function () {
      const toEntry = function (file, i) {
        return '#EXTINF:-1,' + file.path + '\n' + 'http://' + host + '/' + i
      }

      return '#EXTM3U\n' + e.files.filter(filter).map(toEntry).join('\n')
    }

    const toJSON = function () {
      const totalPeers = e.swarm.wires

      const activePeers = totalPeers.filter(function (wire) {
        return !wire.peerChoking
      })

      const totalLength = e.files.reduce(function (prevFileLength, currFile) {
        return prevFileLength + currFile.length
      }, 0)

      const toEntry = function (file, i) {
        return {
          name: file.name,
          url: 'http://' + host + '/' + i,
          length: file.length
        }
      }

      const swarmStats = {
        totalLength,
        downloaded: e.swarm.downloaded,
        uploaded: e.swarm.uploaded,
        downloadSpeed: parseInt(e.swarm.downloadSpeed(), 10),
        uploadSpeed: parseInt(e.swarm.uploadSpeed(), 10),
        totalPeers: totalPeers.length,
        activePeers: activePeers.length,
        files: e.files.filter(filter).map(toEntry)
      }

      return JSON.stringify(swarmStats, null, '  ')
    }

    // Allow CORS requests to specify arbitrary headers, e.g. 'Range',
    // by responding to the OPTIONS preflight request with the specified
    // origin and requested headers.
    if (request.method === 'OPTIONS' && request.headers['access-control-request-headers']) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
      response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      response.setHeader(
        'Access-Control-Allow-Headers',
        request.headers['access-control-request-headers'])
      response.setHeader('Access-Control-Max-Age', '1728000')

      response.end()
      return
    }

    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
    if (u.pathname === '/') u.pathname = '/' + index

    if (u.pathname === '/favicon.ico') {
      response.statusCode = 404
      response.end()
      return
    }

    if (u.pathname === '/.json') {
      const json = toJSON()
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Content-Length', Buffer.byteLength(json))
      response.end(json)
      return
    }

    if (u.pathname === '/.m3u') {
      const playlist = toPlaylist()
      response.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
      response.setHeader('Content-Length', Buffer.byteLength(playlist))
      response.end(playlist)
      return
    }

    e.files.forEach(function (file, i) {
      if (u.pathname.slice(1) === file.name) u.pathname = '/' + i
    })

    const i = Number(u.pathname.slice(1))

    if (isNaN(i) || i >= e.files.length) {
      response.statusCode = 404
      response.end()
      return
    }

    const file = e.files[i]
    let range = request.headers.range
    range = range && rangeParser(file.length, range)[0]
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Content-Type', getType(file.name))
    response.setHeader('transferMode.dlna.org', 'Streaming')
    response.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000')
    if (!range) {
      response.setHeader('Content-Length', file.length)
      if (request.method === 'HEAD') return response.end()
      pump(file.createReadStream(), response)
      return
    }

    response.statusCode = 206
    response.setHeader('Content-Length', range.end - range.start + 1)
    response.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length)
    if (request.method === 'HEAD') return response.end()
    pump(file.createReadStream(range), response)
  })

  server.on('connection', function (socket) {
    socket.setTimeout(36000000)
  })

  return server
}

module.exports = function (torrent, opts) {
  if (!opts) opts = {}

  // Parse blocklist
  if (opts.blocklist) opts.blocklist = parseBlocklist(opts.blocklist)

  const engine = torrentStream(torrent, xtend(opts, { port: opts.peerPort }))

  // Just want torrent-stream to list files.
  if (opts.list) return engine

  // Pause/Resume downloading as needed
  engine.on('uninterested', function () {
    engine.swarm.pause()
  })

  engine.on('interested', function () {
    engine.swarm.resume()
  })

  engine.server = createServer(engine, opts)

  // Listen when torrent-stream is ready, by default a random port.
  engine.on('ready', function () {
    engine.server.listen(opts.port || 0, opts.hostname)
  })

  engine.listen()

  return engine
}
