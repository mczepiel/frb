
var ArrayChanges = require("collections/listen/array-changes");
var PropertyChanges = require("collections/listen/property-changes");
var SortedArray = require("collections/sorted-array");
var Operators = require("./operators");

// primitives

exports.makeLiteralObserver = makeLiteralObserver;
function makeLiteralObserver(literal) {
    return function observeLiteral(emit) {
        return emit(literal) || Function.noop;
    };
}

exports.observeValue = function (emit, value) {
    return emit(value) || Function.noop;
};

exports.observeParameters = function (emit, value, parameters) {
    return emit(parameters) || Function.noop;
};

exports.makeElementObserver = makeElementObserver;
function makeElementObserver(id) {
    return function (emit, value, parameters) {
        return emit(parameters.document.getElementById(id)) || Function.noop;
    };
}

exports.makeComponentObserver = makeComponentObserver;
function makeComponentObserver(label, syntax) {
    return function (emit, value, parameters) {
        if (!parameters.serialization) {
            throw new Error("Can't observe components without serialization parameter");
        }
        var component = parameters.serialization.getObjectByLabel(label)
        syntax.component = component;
        return emit(component) || Function.noop;
    };
}

exports.makeRelationObserver = makeRelationObserver;
function makeRelationObserver(relation, thisp) {
    return function observeRelation(emit, value, parameters) {
        return emit(relation.call(thisp, value)) || Function.noop;
    };
}

exports.makeConverterObserver = makeConverterObserver;
function makeConverterObserver(observeValue, convert, thisp) {
    return function observeConversion(emit, value, parameters, beforeChange) {
        emit = makeUniq(emit);
        return observeValue(autoCancelPrevious(function replaceValue(value) {
            return emit(convert.call(thisp, value));
        }), value, parameters, beforeChange);
    };
}

exports.makeComputerObserver = makeComputerObserver;
function makeComputerObserver(observeArgs, compute, thisp) {
    return function (emit, value, parameters, beforeChange) {
        emit = makeUniq(emit);
        return observeArgs(autoCancelPrevious(function replaceArgs(args) {
            if (!args || !args.every(defined)) return;
            return emit(compute.apply(thisp, args));
        }), value, parameters, beforeChange);
    };
}

exports.observeProperty = _observeProperty;
function _observeProperty(object, key, emit, source, parameters, beforeChange) {
    var cancel = Function.noop;
    function propertyChange(value, key, object) {
        cancel();
        cancel = emit(value, key, object) || Function.noop;
    }
    PropertyChanges.addOwnPropertyChangeListener(object, key, propertyChange, beforeChange);
    propertyChange(object[key], key, object);
    return once(function cancelPropertyObserver() {
        cancel();
        PropertyChanges.removeOwnPropertyChangeListener(object, key, propertyChange, beforeChange);
    });
}

exports.makePropertyObserver = makePropertyObserver;
function makePropertyObserver(observeObject, observeKey) {
    return function observeProperty(emit, value, parameters, beforeChange) {
        return observeKey(autoCancelPrevious(function replaceKey(key) {
            if (key == null) return emit();
            return observeObject(autoCancelPrevious(function replaceObject(object) {
                if (object == null) return emit();
                if (Object.can(object, "observeProperty")) {
                    return object.observeProperty(key, emit, value, parameters, beforeChange);
                } else {
                    return _observeProperty(object, key, emit, value, parameters, beforeChange);
                }
            }), value, parameters, beforeChange);
        }), value, parameters, beforeChange);
    };
}

exports.observeKey = _observeKey;
function _observeKey(collection, key, emit, source, parameters, beforeChange) {
    var cancel = Function.noop;
    var equals = collection.contentEquals || Object.equals;
    function mapChange(value, mapKey, collection) {
        if (equals(key, mapKey)) {
            cancel();
            cancel = emit(value, key, collection) || Function.noop;
        }
    }
    mapChange(collection.get(key), key, collection);
    collection.addMapChangeListener(mapChange, beforeChange);
    return once(function cancelMapObserver() {
        cancel();
        collection.removeMapChangeListener(mapChange, beforeChange);
    });
}

exports.makeGetObserver = makeGetObserver;
function makeGetObserver(observeCollection, observeKey) {
    return function observeMap(emit, value, parameters, beforeChange) {
        return observeCollection(autoCancelPrevious(function replaceCollection(collection) {
            if (!collection) return emit();
            return observeKey(autoCancelPrevious(function replaceKey(key) {
                if (key == null) return emit();
                if (Object.can(collection, "observeKey")) {
                    // polymorphic override
                    return collection.observeKey(key, emit, value, parameters, beforeChange);
                } else {
                    // common case
                    return _observeKey(collection, key, emit, value, parameters, beforeChange);
                }
            }), value, parameters, beforeChange);
        }), value, parameters, beforeChange);
    }
}

exports.makeWithObserver = makeWithObserver;
function makeWithObserver(observeContext, observeExpression) {
    return function observeWith(emit, value, parameters, beforeChange) {
        return observeContext(autoCancelPrevious(function replaceContext(context) {
            return observeExpression(autoCancelPrevious(function replaceValue(value) {
                return emit(value);
            }), context, parameters, beforeChange);
        }), value, parameters, beforeChange);
    };
}

// condition ? consequent : alternate
// {type: "if", args: [condition, consequent, alternate]}
exports.makeConditionalObserver = makeConditionalObserver;
function makeConditionalObserver(observeCondition, observeConsequent, observeAlternate) {
    return function observeConditional(emit, value, parameters, beforeChange) {
        return observeCondition(autoCancelPrevious(function replaceCondition(condition) {
            if (condition == null) {
                return
            } else if (condition) {
                return observeConsequent(emit, value, parameters, beforeChange);
            } else {
                return observeAlternate(emit, value, parameters, beforeChange);
            }
        }), value, parameters, beforeChange);
    };
}

// {type: "record", args: {key: observe}}
// {a: 10, b: c + d}
// {type: "record", args: {a: {type: "literal", value: 10 ...
exports.makeRecordObserver = makeRecordObserver;
function makeRecordObserver(observers) {
    return function observeRecord(emit, value, parameters, beforeChange) {
        var cancelers = {};
        var output = {};
        for (var name in observers) {
            (function (name, observe) {
                cancelers[name] = observe(function (value) {
                    output[name] = value;
                }, value, parameters, beforeChange);
            })(name, observers[name]);
        }
        var cancel = emit(output) || Function.noop;
        return function cancelRecordObserver() {
            cancel();
            for (var name in cancelers) {
                cancelers[name]();
            }
        };
    };
}

exports.makeHasObserver = makeHasObserver;
function makeHasObserver(observeSet, observeValue) {
    return function observeHas(emit, value, parameters, beforeChange) {
        emit = makeUniq(emit);
        return observeValue(autoCancelPrevious(function replaceValue(sought) {
            return observeSet(autoCancelPrevious(function replaceSet(set) {
                if (!set) return emit();
                return observeRangeChange(set, function rangeChange() {
                    // this could be done incrementally if there were guarantees of
                    // uniqueness, but if there are guarantees of uniqueness, the
                    // data structure can probably efficiently check
                    return emit((set.has || set.contains).call(set, sought));
                }, beforeChange);
            }), value, parameters, beforeChange);
        }), value, parameters, beforeChange);
    };
}

exports.makeRangeContentObserver = makeRangeContentObserver;
function makeRangeContentObserver(observeCollection) {
    return function observeContent(emit, value, parameters, beforeChange) {
        return observeCollection(autoCancelPrevious(function (collection) {
            if (!collection || !collection.addRangeChangeListener) {
                return emit(collection);
            } else {
                return observeRangeChange(collection, function rangeChange() {
                    return emit(collection);
                }, beforeChange);
            }
        }), value, parameters, beforeChange);
    };
}

exports.makeMapContentObserver = makeMapContentObserver;
function makeMapContentObserver(observeCollection) {
    return function observeContent(emit, value, parameters, beforeChange) {
        return observeCollection(autoCancelPrevious(function (collection) {
            if (!collection || !collection.addMapChangeListener) {
                return emit(collection);
            } else {
                return observeMapChange(collection, function rangeChange() {
                    return emit(collection);
                }, beforeChange);
            }
        }), value, parameters, beforeChange);
    };
}

exports.makeMapFunctionObserver = makeNonReplacing(makeReplacingMapFunctionObserver);
function makeReplacingMapFunctionObserver(observeCollection, observeRelation) {
    return function (emit, value, parameters, beforeChange) {
        return observeRelation(autoCancelPrevious(function replaceRelation(relation) {
            if (!relation) return emit();
            return observeCollection(autoCancelPrevious(function replaceMapInput(input) {
                if (!input) return emit();
                var output = [];
                var cancel = observeRangeChange(input, function rangeChange(plus, minus, index) {
                    output.swap(index, minus.length, plus.map(relation));
                }, beforeChange);
                emit(output, input);
                return cancel;
            }), value, parameters, beforeChange);
        }), value, parameters, beforeChange);
    };
}

// object.array.splice(0, 1, 2);
// object.array = [1, 2, 3]
var makeMapBlockObserver = exports.makeMapBlockObserver = makeNonReplacing(makeReplacingMapBlockObserver);
function makeReplacingMapBlockObserver(observeCollection, observeRelation) {
    return function observeMap(emit, value, parameters, beforeChange) {
        return observeCollection(autoCancelPrevious(function replaceMapInput(input) {
            if (!input) return emit();

            var output = [];
            var indexRefs = [];
            var cancelers = [];

            function update(index) {
                for (; index < input.length; index++) {
                    indexRefs[index].index = index;
                }
            }

            function rangeChange(plus, minus, index) {
                indexRefs.swap(index, minus.length, plus.map(function (value, offset) {
                    return {index: index + offset};
                }));
                update(index + plus.length);
                var initialized;
                var mapped = [];
                cancelEach(cancelers.swap(index, minus.length, plus.map(function (value, offset) {
                    var indexRef = indexRefs[index + offset];
                    return observeRelation(autoCancelPrevious(function replaceRelationOutput(value) {
                        if (initialized) {
                            output.set(indexRef.index, value);
                        } else {
                            mapped[offset] = value;
                        }
                    }), value, parameters, beforeChange);
                })));
                initialized = true;
                output.swap(index, minus.length, mapped);
            }

            var cancelRangeChange = observeRangeChange(input, rangeChange);
            // passing the input as a second argument is a special feature of a
            // mapping observer, utilized by filter observers
            var cancel = emit(output, input) || Function.noop;

            return once(function cancelMapObserver() {
                cancel();
                cancelEach(cancelers);
                cancelRangeChange();
            });
        }), value, parameters, beforeChange);
    };
}

// TODO makeFilterFunctionObserver

var makeFilterBlockObserver = exports.makeFilterBlockObserver = makeNonReplacing(makeReplacingFilterBlockObserver);
function makeReplacingFilterBlockObserver(observeArray, observePredicate) {
    var observePredicates = makeReplacingMapBlockObserver(observeArray, observePredicate);
    return function observeFilter(emit, value, parameters, beforeChange) {
        return observePredicates(autoCancelPrevious(function (predicates, input) {
            if (!input) return emit();

            var output = [];
            var cancelers = [];
            var cumulativeLengths = [0];

            function update(index) {
                for (; index < predicates.length; index++) {
                    cumulativeLengths[index + 1] = cumulativeLengths[index] + predicates[index];
                }
            }

            function rangeChange(plusPredicates, minusPredicates, index) {
                var plusValues = input.slice(index, index + plusPredicates.length);
                var oldLength = minusPredicates.map(Boolean).sum();
                var newLength = plusPredicates.map(Boolean).sum();
                var length = newLength - oldLength;
                var plusOutput = plusValues.filter(function (value, offset) {
                    return plusPredicates[offset];
                });
                var start = cumulativeLengths[index];
                output.swap(start, Math.max(0, oldLength - newLength), plusOutput);
                update(start);
            }

            var cancelRangeChange = observeRangeChange(predicates, rangeChange, beforeChange);
            var cancel = emit(output) || Function.noop;
            return once(function cancelFilterObserver() {
                cancel();
                cancelEach(cancelers);
                cancelRangeChange();
            });

        }), value, parameters, beforeChange);
    };
}

exports.makeSomeBlockObserver = makeSomeBlockObserver;
function makeSomeBlockObserver(observeCollection, observePredicate) {
    // collection.some{predicate} is equivalent to
    // collection.filter{predicate}.length !== 0
    var observeFilter = makeFilterBlockObserver(observeCollection, observePredicate);
    var observeLength = makePropertyObserver(observeFilter, observeLengthLiteral);
    return makeConverterObserver(observeLength, Boolean);
}

exports.makeEveryBlockObserver = makeEveryBlockObserver;
function makeEveryBlockObserver(observeCollection, observePredicate) {
    // collection.every{predicate} is equivalent to
    // collection.filter{!predicate}.length === 0
    var observeNotPredicate = makeConverterObserver(observePredicate, Operators.not);
    var observeFilter = makeFilterBlockObserver(observeCollection, observeNotPredicate);
    var observeLength = makePropertyObserver(observeFilter, observeLengthLiteral);
    return makeConverterObserver(observeLength, Operators.not);
}

// used by both some and every blocks
var observeLengthLiteral = makeLiteralObserver("length");

// TODO makeSortedFunctionObserver

exports.makeSortedBlockObserver = makeNonReplacing(makeReplacingSortedBlockObserver);
function makeReplacingSortedBlockObserver(observeCollection, observeRelation) {
    var observePack = makePackingObserver(observeRelation);
    var observeMapPack = makeReplacingMapBlockObserver(observeCollection, observePack);
    var observeSort = function (emit, value, parameters, beforeChange) {
        return observeMapPack(autoCancelPrevious(function (input) {
            if (!input) return emit();

            var output = [];
            var sorted = SortedArray(
                output,
                function equals(x, y) {
                    return Object.equals(x.value, y.value);
                },
                function compare(x, y) {
                    return Object.compare(x.value, y.value);
                }
            );
            function rangeChange(plus, minus) {
                sorted.addEach(plus);
                sorted.deleteEach(minus);
            }
            var cancelRangeChange = observeRangeChange(input, rangeChange, beforeChange);
            var cancel = emit(output) || Function.noop;
            return function cancelSortedObserver() {
                cancel();
                cancelRangeChange();
            };
        }), value, parameters, beforeChange);
    };
    return makeReplacingMapBlockObserver(observeSort, observeUnpack);
}

function makePackingObserver(observeRelation) {
    return function (emit, key, parameters, beforeChange) {
        return observeRelation(autoCancelPrevious(function (value) {
            return emit({key: key, value: value}) || Function.noop;
        }), key, parameters, beforeChange);
    };
}

function observeUnpack(emit, item) {
    return emit(item.key) || Function.noop;
}

// TODO makeSortedSetFunctionObserver
// TODO makeSortedSetBlockObserver

exports.makeOperatorObserverMaker = makeOperatorObserverMaker;
function makeOperatorObserverMaker(operator) {
    return function makeOperatorObserver(/*...observers*/) {
        var observeOperands = makeObserversObserver(Array.prototype.slice.call(arguments));
        var observeOperandChanges = makeRangeContentObserver(observeOperands);
        return function observeOperator(emit, value, parameters, beforeChange) {
            return observeOperandChanges(autoCancelPrevious(function (operands) {
                if (operands.every(defined)) {
                    return emit(operator.apply(void 0, operands));
                } else {
                    return emit()
                }
            }), value, parameters, beforeChange);
        };
    };
}

function defined(x) {
    return x != null;
}

exports.makeTupleObserver = makeTupleObserver;
function makeTupleObserver() {
    return makeObserversObserver(Array.prototype.slice.call(arguments));
}

// accepts an array of observers and emits an array of the corresponding
// values, incrementally updated
exports.makeObserversObserver = makeObserversObserver;
function makeObserversObserver(observers) {
    return function observeObservers(emit, value, parameters, beforeChange) {
        var output = Array(observers.length);
        for (var i = 0; i < observers.length; i++) {
            output[i] = undefined; // pevent sparse/holes
        }
        var cancelers = observers.map(function observeObserver(observe, index) {
            return observe(function replaceValue(value) {
                output.set(index, value);
            }, value, parameters, beforeChange);
        })
        var cancel = emit(output) || Function.noop;
        return once(function cancelObserversObserver() {
            cancel();
            cancelEach(cancelers);
        });
    };
}

// calculating the reflected index for an incremental change:
// [0, 1, 2, 3]  length 4
//     -------  -4 (1+3)
// --------    0-  (outer.length - index - inner.length)
exports.makeReversedObserver = makeNonReplacing(makeReplacingReversedObserver);
function makeReplacingReversedObserver(observeArray) {
    return function observeReversed(emit, value, parameters, beforeChange) {
        return observeArray(autoCancelPrevious(function (input) {
            if (!input) return emit();

            var output = [];
            function rangeChange(plus, minus, index) {
                var reflected = output.length - index - minus.length;
                output.swap(reflected, minus.length, plus.reversed());
            };
            var cancelRangeChange = observeRangeChange(input, rangeChange, beforeChange);
            var cancel = emit(output);
            return once(function cancelReversedObserver() {
                cancel();
                cancelRangeChange();
            });
        }), value, parameters, beforeChange);
    };
}

exports.makeViewObserver = makeNonReplacing(makeReplacingViewObserver);
function makeReplacingViewObserver(observeInput, observeStart, observeLength) {
    return function observeView(emit, value, parameters, beforeChange) {
        return observeInput(autoCancelPrevious(function (input) {
            if (!input) return emit();
            return observeLength(autoCancelPrevious(function (length) {
                if (length == null) return emit();
                var previousStart;
                return observeStart(autoCancelPrevious(function (start) {
                    if (start == null) return emit();
                    var output = [];
                    function rangeChange(plus, minus, index) {
                        var diff = plus.length - minus.length;
                        if (index < start && diff < 0 && diff < length) { // shrink before
                            // inject elements at the end
                            output.swap(output.length, 0, input.slice(start + length + diff, start + length));
                            // remove elements at the beginning
                            output.splice(0, -diff);
                        } else if (index < start && diff > 0 && diff < length) { // grow before
                            // inject elements
                            output.swap(0, 0, input.slice(start, start + diff));
                            // remove elements from end
                            output.splice(output.length - diff, diff);
                        } else if (index >= start && diff < 0 && index < start + length) { // shrink within
                            // inject elements to end
                            output.swap(output.length, 0, input.slice(start + length + diff, start + length));
                            // remove elements from within
                            output.splice(index - start, -diff);
                        } else if (index >= start && diff > 0 && index < start + length) { // grow within
                            // inject elements within
                            output.swap(index - start, 0, input.slice(index, index + diff));
                            // remove elements from end
                            output.splice(output.length - diff, diff);
                        } else if (index < start + length) {
                            output.swap(0, output.length, input.slice(start, start + length));
                        }
                    }
                    var cancelRangeChange = observeRangeChange(input, rangeChange, beforeChange);
                    var cancel = emit(output) || Function.noop;
                    return once(function cancelViewObserver() {
                        cancel();
                        cancelRangeChange();
                    });
                }), value, parameters, beforeChange);
            }), value, parameters, beforeChange);
        }), value, parameters, beforeChange);
    };
}

exports.makeFlattenObserver = makeNonReplacing(makeReplacingFlattenObserver);
function makeReplacingFlattenObserver(observeArray) {
    return function (emit, value, parameters, beforeChange) {
        return observeArray(autoCancelPrevious(function (input) {
            if (!input) return emit();

            var output = [];
            var cancelers = [];
            var cumulativeLengths = [0];
            var indexRefs = [];

            function update(i) {
                for (var j = i; j < input.length; j++) {
                    indexRefs[j].index = j;
                    cumulativeLengths[j + 1] = cumulativeLengths[j] + input[j].length;
                }
            }

            function rangeChange(plus, minus, i) {

                // minus
                var start = cumulativeLengths[i];
                var end = cumulativeLengths[i + minus.length];
                var length = end - start;
                output.swap(start, length, []);

                indexRefs.swap(i, minus.length, plus.map(function () {
                    return {index: null};
                }));
                update(i);

                // plus
                cancelEach(cancelers.swap(
                    i,
                    minus.length,
                    plus.map(function (inner, j) {
                        var index = indexRefs[i + j];
                        function innerRangeChange(plus, minus, k) {
                            update(index.index);
                            var start = cumulativeLengths[index.index] + k;
                            var end = cumulativeLengths[index.index] + k + minus.length;
                            var length = end - start;
                            output.swap(start, length, plus);
                        }
                        return observeRangeChange(inner, innerRangeChange, beforeChange);
                    })
                ));

            }

            var cancelRangeChange = observeRangeChange(input, rangeChange, beforeChange);
            var cancel = emit(output) || Function.noop;

            return once(function cancelFlattenObserver() {
                cancel();
                cancelEach(cancelers);
                cancelRangeChange();
            });
        }), value, parameters, beforeChange);
    };
}

exports.makeEnumerationObserver = makeNonReplacing(makeReplacingEnumerationObserver);
function makeReplacingEnumerationObserver(observeArray) {
    return function (emit, value, parameters, beforeChange) {
        return observeArray(autoCancelPrevious(function replaceArray(input) {
            if (!input) return emit();

            var output = [];
            function update(index) {
                for (; index < output.length; index++) {
                    output[index].set(0, index);
                }
            }
            function rangeChange(plus, minus, index) {
                output.swap(index, minus.length, plus.map(function (value, offset) {
                    return [index + offset, value];
                }));
                update(index + plus.length);
            }
            var cancelRangeChange = observeRangeChange(input, rangeChange, beforeChange);
            var cancel = emit(output) || Function.noop;
            return function cancelEnumerationObserver() {
                cancel();
                cancelRangeChange();
            };
        }), value, parameters, beforeChange);
    };
}

function cancelEach(cancelers) {
    cancelers.forEach(function (cancel) {
        if (cancel) {
            cancel();
        }
    });
}

// a utility for generating map and filter observers because they both replace
// the output array whenever the input array is replaced.  instead, this
// wrapper receives the replacement array and mirrors it on an output array
// that only gets emitted once.
function makeNonReplacing(wrapped) {
    return function () {
        var observe = wrapped.apply(this, arguments);
        return function (emit, value, parameters, beforeChange) {
            var output = [];
            var cancelObserver = observe(autoCancelPrevious(function (input) {
                if (!input) {
                    output.clear();
                } else {
                    output.swap(0, output.length, input);
                    function rangeChange(plus, minus, index) {
                        output.swap(index, minus.length, plus);
                    }
                    // TODO fix problem that this would get called twice on replacement
                    return once(input.addRangeChangeListener(rangeChange, beforeChange));
                }
            }), value, parameters, beforeChange);
            var cancel = emit(output) || Function.noop;
            return once(function cancelNonReplacingObserver() {
                cancelObserver();
                cancel();
            });
        };
    };
}

exports.makeSumObserver = makeCollectionObserverMaker(function setup() {
    var sum = 0;
    return function rangeChange(plus, minus, index) {
        sum += plus.sum() - minus.sum();
        return sum;
    };
});

exports.makeAverageObserver = makeCollectionObserverMaker(function setup() {
    var sum = 0;
    var count = 0;
    return function rangeChange(plus, minus, index) {
        sum += plus.sum() - minus.sum();
        count += plus.length - minus.length;
        return sum / count;
    };
});

// a utility for generating sum and average observers since they both need to
// capture some internal state on intiailization, and update that state on
// range changes.
function makeCollectionObserverMaker(setup) {
    return function (observeCollection) {
        return function (emit, value, parameters, beforeChange) {
            emit = makeUniq(emit);
            return observeCollection(autoCancelPrevious(function (collection) {
                if (!collection) return emit();
                var rangeChange = setup(collection, emit);
                return observeRangeChange(collection, function (plus, minus, index) {
                    return emit(rangeChange(plus, minus, index));
                });
            }), value, parameters, beforeChange);
        };
    };
}

function observeRangeChange(collection, emit, beforeChange) {
    var cancelChild = Function.noop;
    function rangeChange(plus, minus, index) {
        cancelChild();
        cancelChild = emit(plus, minus, index) || Function.noop;
    }
    rangeChange(collection, [], 0);
    var cancelRangeChange = collection.addRangeChangeListener(rangeChange, beforeChange);
    return once(function cancelRangeObserver() {
        cancelChild();
        cancelRangeChange();
    });
}

function observeMapChange(collection, emit, beforeChange) {
    var cancelChild = Function.noop;
    function mapChange() {
        cancelChild();
        cancelChild = emit(collection) || Function.noop;
    }
    mapChange();
    var cancelMapChange = collection.addMapChangeListener(mapChange, beforeChange);
    return once(function cancelMapObserver() {
        cancelChild();
        cancelMapChange();
    });
}

// wraps an emitter such that repeated values are ignored
exports.makeUniq = makeUniq;
function makeUniq(emit) {
    var previous;
    return function uniqEmit(next) {
        if (next !== previous) {
            var result = emit.apply(this, arguments);
            previous = next;
            return result;
        }
    };
}

// wraps an emitter that returns a canceler.  each time the wrapped function is
// called, it cancels the previous canceler, and calls the last canceler when
// it is canceled.  this is useful for observers that update a value and attach
// a new event listener tree to the value.
exports.autoCancelPrevious = autoCancelPrevious;
function autoCancelPrevious(emit) {
    var cancelPrevious = Function.noop;
    return function cancelPreviousAndReplace(value) {
        cancelPrevious();
        cancelPrevious = emit.apply(this, arguments) || Function.noop;
        return function cancelLast() {
            cancelPrevious();
        };
    };
}

exports.once = once;
function once(callback) {
    var done;
    return function once() {
        if (done) {
            return Function.noop; // TODO fix bugs that make this sensitive
            //throw new Error("Redundant call: " + callback + " " + done.stack + "\nSecond call:");
        }
        done = true;
        //done = new Error("First call:");
        return callback.apply(this, arguments);
    }
}

