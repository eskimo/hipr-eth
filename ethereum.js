'use strict';

const ethers = require('ethers');
const {encoding, wire, util} = require('bns');
const LRU = require('blru');

const ENS_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENS_ABI = [
    'function setOwner(bytes32 node, address owner) external @500000',
    'function setSubnodeOwner(bytes32 node, bytes32 label, address owner) external @500000',
    'function setResolver(bytes32 node, address resolver) external @500000',
    'function owner(bytes32 node) external view returns (address)',
    'function resolver(bytes32 node) external view returns (address)'
];
const RESOLVER_ABI = [
    'function interfaceImplementer(bytes32 nodehash, bytes4 interfaceId) view returns (address)',
    'function addr(bytes32 nodehash) view returns (address)',
    'function setAddr(bytes32 nodehash, address addr) @500000',
    'function name(bytes32 nodehash) view returns (string)',
    'function setName(bytes32 nodehash, string name) @500000',
    'function text(bytes32 nodehash, string key) view returns (string)',
    'function setText(bytes32 nodehash, string key, string value) @500000',
    'function contenthash(bytes32 nodehash) view returns (bytes)',
    'function setContenthash(bytes32 nodehash, bytes contenthash) @500000',
    'function ABI(bytes32 node, uint256 contentType) view returns (uint256, bytes)',
    'function dnsRecord(bytes32 node, bytes32 name, uint16 resource) view returns (bytes)',
    'function hasDNSRecords(bytes32 node, bytes32 name) view returns (bool)'
];

const CACHE_TTL = 30 * 60 * 1000;
const CACHE_TAGS = {
  DNS: 0,
  RESOLVER: 1
}

class Ethereum {
  constructor(options) {
    this.keccak256 = ethers.utils.keccak256;
    this.namehash = ethers.utils.namehash;

    this.provider = new ethers.getDefaultProvider('https://rpc.ankr.com/eth', options);

    this.ensRegistry = new ethers.Contract(ENS_ADDRESS, ENS_ABI, this.provider);
    this.ensResolver = null;
    this.cache = new EthereumCache(3000);
  }

  async init() {
    this.ensResolver = await this.getEnsResolver('eth');
  }

  async getEnsResolver(name) {
    return this.getResolver(name, ENS_ADDRESS);
  }

  async getResolverFromRegistry(name, registry) {
    const resolverAddr = await registry.resolver(this.namehash(name));
    if (resolverAddr === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return new ethers.Contract(resolverAddr, RESOLVER_ABI, this.provider);
  }

  async getResolver(name, registryAddress) {
    const cache = this.cache.getResolver(name, registryAddress);
    if (cache) {
      return cache;
    }

    const registry = this.getAbstractEnsRegistry(registryAddress);
    const resolver = await this.getResolverFromRegistry(
      name,
      registry
    );

    this.cache.setResolver(name, registryAddress, resolver);
    return resolver;
  }

  getAbstractEnsRegistry(address) {
    return new ethers.Contract(address, ENS_ABI, this.provider);
  }

  async resolveEnsAddress(name) {
    return this.provider.resolveName(name);
  }

  // https://eips.ethereum.org/EIPS/eip-634
  async resolveEnsText(name, key) {
    const nameResolver = await this.provider.getResolver(name);

    if (!nameResolver)
      return null;

    return nameResolver.getText(key);
  }

  async resolveDnsFromEns(name, type, node) {
    if (!node)
      node = this.toNode(name);

    const resolver = await this.getEnsResolver(util.trimFQDN(node));
    return this.resolveDnsWithResolver(name, type, node, resolver);
  }

  async getRRSet(name, type, node, resolver) {
    if (!resolver) {
      return null;
    }

    let record = this.cache.getRecord(name, type, resolver.address);
    if (!record) {
      record = await resolver.dnsRecord(
        this.namehash(util.trimFQDN(node)),
        this.hashDnsName(name),
        type
      );

      this.cache.setRecord(name, type, resolver.address, record);
    }

    if (!record || record === '0x')
      return null;

    // prefixed with "0x" of course...
    return Buffer.from(record.substr(2), 'hex');
  }

  async resolveDnsWithResolver(name, type, node, resolver) {
    const rrSet = await this.getRRSet(name, type, node, resolver);
    if (rrSet) {
      // if looking for NS, include DS in response
      if (type === wire.types.NS) {
        let dsSet = await this.getRRSet(name, wire.types.DS, node, resolver);
        if (dsSet)
          return Buffer.concat([rrSet, dsSet]);
      }

      return rrSet;
    }

    // NS/CNAME fallback:
    // Technically, if NS/CNAME exists
    // no other record types must be present
    // but we don't have the full zone due to
    // how EIP-1185 works. For zones setup
    // correctly this isn't an issue.

    // For NS lookups we use the node name not qname
    // ideally we should keep adding labels (to the left)
    // starting from node to qname until we find a delegation
    // but this adds too many lookups
    const sname = util.fqdn(node);
    let nsSet = await this.getRRSet(sname, wire.types.NS, node, resolver);
    if (nsSet) {
      let dsSet = await this.getRRSet(sname, wire.types.DS, node, resolver);
      if (dsSet)
        return Buffer.concat([nsSet, dsSet]);

      return nsSet;
    }

    // Finally, look for a CNAME
    return this.getRRSet(name, wire.types.CNAME, node, resolver);
  }

  async resolveDnsFromAbstractEns(name, type, ns, node) {
    if (!node)
      node = this.toNode(name);

    const labels = ns.split('.');

    if (labels.length !== 3)
      return null;

    if (labels[1] !== '_eth')
      return null;

    const addr = labels[0];
    if (addr.length !== 42)
      return null;

    const resolver = await this.getResolver(
      util.trimFQDN(node),
      addr
    );

    return this.resolveDnsWithResolver(name, type, node, resolver);
  }

  async resolveDnsFromRegistry(name, type, registryAddress, node) {
    if (!node)
      node = this.toNode(name);

    const resolver = await this.getResolver(
      util.trimFQDN(node),
      registryAddress
    );

    return this.resolveDnsWithResolver(name, type, node, resolver);
  }

  hashDnsName(name) {
    const DNSName = encoding.packName(name);
    return this.keccak256(DNSName);
  }

  toNode(name) {
    let node = name
    const labels = util.trimFQDN(name).split('.');

    if (labels.length > 1)
      node = labels.slice(-2).join('.')

    return node
  }
}

class EthereumCache {
  constructor(size) {
    this.cache = new LRU(size);
  }

  setRecord(name, type, resolverAddress, record) {
    const key = this.toDnsKey(name, type, resolverAddress);

    if (!record)
      record = '0x'

    this.cache.set(key, {
      time: Date.now(),
      record
    });
  }

  getRecord(name, type, resolverAddress) {
    const key = this.toDnsKey(name, type, resolverAddress);
    const item = this.cache.get(key);

    if (!item)
      return null;

    if (Date.now() > item.time + CACHE_TTL)
      return null;

    return item.record;
  }

  setResolver(node, registryAddress, resolver) {
    if (!resolver)
      return;

    const key = this.toResolverKey(node, registryAddress);

    this.cache.set(key, {
      time: Date.now(),
      resolver
    });
  }

  getResolver(node, registryAddress) {
    const key = this.toResolverKey(node, registryAddress);
    const item = this.cache.get(key);

    if (!item)
      return null;

    if (Date.now() > item.time + CACHE_TTL)
      return null;

    return item.resolver;
  }

  toDnsKey(name, type, resolverAddress) {
    let key = CACHE_TAGS.DNS.toString() + ';';
    key += name + ';';
    key += type.toString() + ';';
    key += resolverAddress;

    return key;
  }

  toResolverKey(node, registryAddress) {
    let key = CACHE_TAGS.RESOLVER.toString() + ';';
    key += node + ';';
    key += registryAddress;

    return key;
  }

  reset() {
    this.cache.reset();
  }
}

module.exports = Ethereum;
