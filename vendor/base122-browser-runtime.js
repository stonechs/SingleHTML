// Base122 decoder adapted from Kevin Albertson, MIT; see base122-LICENSE.txt.
(function () {
  function decode(encoded) {
    var output = [], pending = 0, bits = 0;
    var illegals = [0, 10, 13, 34, 38, 92];
    function push(value) {
      pending = pending << 7 | value;
      bits += 7;
      if (bits >= 8) {
        bits -= 8;
        output.push(pending >>> bits & 255);
      }
    }
    for (var i = 0; i < encoded.length; i++) {
      var value = encoded.charCodeAt(i), index = value >>> 8 & 7;
      if (value > 127 && index !== 7) push(illegals[index]);
      push(value & 127);
    }
    return output;
  }
  var bytes = decode('__HTMLPACK_PAYLOAD__');
  __ROADROLLER_EXECUTE__;
})();
