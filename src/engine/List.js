function List(head, tail) {
  let _head = head;
  let _tail = tail;

  if (tail === undefined) {
    // empty list for tail
    _tail = new List([], []);
  }

  this.getHead = function getHead() {
    return [].concat(_head);
  };

  this.getTail = function getTail() {
    return _tail;
  };

  this.isGround = function isGround() {
    let result = true;

    for (let i = 0; i < _head.length; i += 1) {
      if (!_head[i].isGround()) {
        result = false;
        break;
      }
    }

    if (!(_tail instanceof Array)) {
      result = result && _tail.isGround();
    }

    return result;
  };

  this.getVariables = function getVariables() {
    let hash = {};

    let processArg = function processArg(arg) {
      arg.getVariables().forEach((argVar) => {
        hash[argVar] = true;
      });
    };

    _head.forEach(processArg);

    tail.getVariables().forEach((varName) => {
      hash[varName] = true
    });

    return Object.keys(hash);
  };

  this.substitute = function substitute(theta) {
    let flattenedList = this.flatten();
    flattenedList = flattenedList.map((element) => {
      return element.substitute(theta);
    });
    return new List(flattenedList);
  };

  this.flatten = function flatten() {
    let result = [];
    if (_head.length > 0) {
      result = result.concat(_head);
      if (_tail instanceof List) {
        result = result.concat(_tail.flatten());
      }
    }
    return result;
  }

  this.isEmpty = function isEmpty() {
    return _head.length === 0;
  };

  this.toString = function toString() {
    let result = '';
    result += '[';
    for (let j = 0; j < _head.length; j += 1) {
      result += _head[j];
      if (j < _head.length - 1) {
        result += ', ';
      }
    }
    if (!(_tail instanceof List) || !_tail.isEmpty()) {
      result += '|' + _tail.toString();
    }
    result += ']';
    return result;
  };
}

module.exports = List;