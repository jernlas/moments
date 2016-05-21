/*jslint browser: true, devel: true, continue: true, eqeq: true, newcap: true, nomen: true, plusplus: true, sloppy: true, vars: true, indent: 2, maxerr: 1000 */

/*
When running .then, what happens is that a callback function is
added as well as a new branch of deferreds. So the star marked
area is basically what is added on a .then call.

This structure can be constructed by these calls on a deferred, d:

d.then(func1);
d.then(func2).then(func3);

if func1 throws, then it is d2's responsibility to handle that
error. On the other hand if func2 throws, then it is either d3's
OR d4's task to clean up the mess. Basically each branch of a
deferred that has thrown an error must handle it somewhere down
the line. If d4 would have d5 and d6 connected to it and func2
threw an error without d3 or d4 handling it, then BOTH d5 and d6
must handle it since d4 is "rethrowing" the error further down the
chain.

     d
     |
    /+\-----+
   / | \    |
func1|func2 |
  |  |  |   |
 d2  |  d3  |
     |  |   |
     +------+
       func3
        |
        d4

     d----errorHandler that can catch explicit deferred.errback(e)
     |
    / \
   /   \
func1 func2
  |     |
 d2     d3----errorHandler for func2
       /| \
      / |  \--errorHandler2 for func2
     /  |
 func3 func4
    |   |
    d5  d4----errorHandler for func2 or func4

reArrangeBranch makes the structure of the tree always
conform to this style when branching on deferreds. Every
sinlge star contained area is a branch.

   +--d---+
   |      |
  ***    ***
  *d*    *d*
  *|*    *|*
  *|*    *|*
  *d*    *d*
  *|*    *|*
  *|*    *|*
  *d*    *d*
  ***    ***
   | \______
  ***     ***
  *d*     *d*
  *|*     *|*
  *|*     *|*
  *d*     *d*
  ***     ***

*/

var Deferred = function (root, branch) {
  if (!(this instanceof Deferred)) {
    return new Deferred(root, branch);
  }
  var that = this;

  if (!root) {
    root = this;
  }
  if (!branch) {
    branch = this;
  }

  var callbacked = false;
  var callbackArgs = [];

  var errbacked = false;
  var errbackError = new Error("errback called without error as argument!");

  var aborted = false;
  var abortArgs;
  var abortFunctions = [];

  var nextLinks = [];
  this._nextLinks = nextLinks;
  var callbackFunctions = [];
  var errbackFunctions = [];
  this._errbackFunctions = errbackFunctions;

  var progressFunctions = [];
  var done;
  var outOf;

  var partialResultFunctions = [];

  var finallyFunction;

  this.isAborted = function () {
    return aborted;
  };

  this.getCallbackArgs = function () {
    return callbackArgs;
  };

  this.runErrback = function (e, faultyFunction) {
    var errorHandled = false;
    if (errbacked) {
      return that;
    }
    if (aborted) {
      return that;
    }
    errbacked = true;
    errbackError = e;

    // go through all errbackFunctions
    var i;
    for (i = 0; i < errbackFunctions.length; i++) {
      try {
        errorHandled = true;
        errbackFunctions[i](e);
      } catch (e2) {
        console.log("error in errback, won't continue! " + (e2.stack ? e2.stack : e2.message));
        throw new Error("error in errback, won't continue!");
      }
    }

    if (errorHandled === false) {
      // if there was no error handlers on this deferred. We must check
      // each and every one of the next links. And all of them must
      // handle the error somewhere, otherwise we have a miss !
      var j;
      for (j = 0; j < nextLinks.length; ++j) {
        errorHandled = errorHandled || nextLinks[j].runErrback(errbackError);
      }

      if (errorHandled === false) {
        // If we have a default error handler registered, use it !
        if (Deferred.defaultErrorHandler) {
          Deferred.defaultErrorHandler(errbackError);
          return;
        }
        // We still haven't handled the error  :/
        if (faultyFunction === undefined) {
          console.log("error not handled in errback or in the rest of the chain! rethrowing..." + (e.stack ? e.stack : e.message));
        } else {
          console.log("Error in callback Function: " + faultyFunction);
        }
        throw errbackError;
      }
    }

    // We don't need these anymore since it's no longer
    // possible to call abort
    root = undefined;
    branch = undefined;

    if (finallyFunction) {
      finallyFunction();
    }

    return errorHandled;
  };

  this.runCallback = function () {
    if (callbacked) {
      throw new Error("Deferred has already been callbacked!");
    }
    if (errbacked) {
      return;
    }
    callbacked = true;
    callbackArgs = arguments;

    if (finallyFunction) {
      finallyFunction();
      return;
    }
    // go through all callbackFunctions
    var i;
    for (i = 0; i < callbackFunctions.length; ++i) {
      // Skip it if it has been aborted.
      if (nextLinks[i].isAborted()) {
        continue;
      }
      try {
        // run the callback, and save the result
        var returnValueFromCallback = callbackFunctions[i].apply(that, arguments);
        // If the returnValue was a deferred, we must wait
        // for that before we run the chained deferreds.
        if (returnValueFromCallback instanceof Deferred) {
          // We create an inline funciton here since we must create
          // a copy of the current value of i for each next link.
          // Otherwise, it will be overwritten in the next iteration
          // of the loop, and the callback below would use the wrong
          // value of i.
          (function () {
            var persistentI = i;
            var persistentDeferred = returnValueFromCallback;
            persistentDeferred
            .then(function () {
              nextLinks[persistentI].runCallback.apply(nextLinks[persistentI], persistentDeferred.getCallbackArgs());
            })
            .orIfError(function (ex) {
              // If there is no error handler on the earlier deferred, throw it "out/up one level".
              if (persistentDeferred._errbackFunctions.length === 0) {
                nextLinks[persistentI].runErrback(ex, callbackFunctions[persistentI]);
              }
            });
          }());
        } else {
          nextLinks[i].runCallback(returnValueFromCallback);
        }
      } catch (e) {
        // Check for errback in the next deferred matching the index
        // of the one that erred. Also send the method that faulted.
        nextLinks[i].runErrback(e, callbackFunctions[i]);
      }
    }
    // After the callbacks has been run, we can remove the links backwards
    // since abort is not usable anymore
    root = undefined;
    branch = undefined;
  };

  // This is the starting point of the whole structure. When callback is
  // called, it is then the usefulness of the deferred comes into play.
  // Callback fires all callbackFunctions which in their turn fires
  // all their chains connected to them.

  // Even though no arguments is shown in the header, arguments will be
  // passed on but via the arguments object.
  this.callback = function () {
    if (aborted) {
      return that;
    }
    if (errbacked) {
      return that;
    }
    callbackArgs = arguments;
    // Timeout of 0 to guarantee that the creator of the deferred
    // have time to attach a then function, even if the deferred
    // is returned as already callbacked.
    setTimeout(function () {
      that.runCallback.apply(that, callbackArgs);
    }, 0);
    return that;
  };

  this.errback = function (e) {
    if (aborted) {
      return that;
    }
    if (errbacked) {
      console.log("Deferred is already errbacked, won't run errback!");
      return that;
    }
    // Timeout of 0 to guarantee that the creator of the deferred
    // have time to attach a then function, even if the deferred
    // is returned as already callbacked.
    setTimeout(function () {
      that.runErrback(e);
    }, 0);
    return that;
  };

  this.reArrangeBranch = function () {
    nextLinks[0].setBranch(nextLinks[0]);
  };

  this.setBranch = function (newBranch) {
    branch = newBranch;
    if (nextLinks.length === 1) {
      nextLinks[0].setBranch(newBranch);
    } else {
      var i;
      for (i = 0; i < nextLinks.length; ++i) {
        nextLinks[i].setBranch(nextLinks[i]);
      }
    }
  };

  // Clears the root and branch links allowing the
  // chain to be garbage collected. Since there only
  // exist forward links, garbage collection will start
  // on the first node and procceed forward
  this.breakBackLinks = function () {
    var i;
    for (i = 0; i < nextLinks.length; ++i) {
      nextLinks[i].breakBackLinks();
      branch = undefined;
      root = undefined;
    }
  };

  this.then = function (callbackFunction) {
    var next;
    if (callbackFunctions.length > 0) {
      next = new Deferred(root);
      nextLinks.push(next);
      if (branch && callbackFunctions.length === 1) {
        branch.reArrangeBranch();
      }
    } else {
      next = new Deferred(root, branch);
      nextLinks.push(next);
    }
    callbackFunctions.push(callbackFunction);
    if (aborted) {
      setTimeout(function () {
        nextLinks[nextLinks.length - 1].propagateAbort();
      }, 0);
      return that;
    }
    // If this deferred is already callbacked, then we need
    // to call the callback, but not without first reaching
    // the js main loop so that the we don't break our rule
    // of letting all code before reaching js mainloop run
    // before we run the callbacks.
    if (errbacked) {
      setTimeout(function () {
        next.runErrback(errbackError);
      }, 0);
    } else if (callbacked) {
      setTimeout(function () {
        callbackFunction.apply(that, callbackArgs);
      }, 0);
    }
    return next;
  };

  this.orIfError = function (errbackFunction) {
    if (aborted) {
      console.log("Deferred has been aborted, can't add errback!");
      return that;
    }
    errbackFunctions.push(errbackFunction);
    // If the error is already done, just call this function
    // after reaching the js main loop.
    if (errbacked) {
      setTimeout(function () {
        if (aborted) {
          return;
        }
        try {
          errbackFunctions(errbackError);
        } catch (e) {
          console.log("error in errback, won't continue! " + (e.stack ? e.stack : e.message));
        }
      }, 0);
    }
    return that;
  };

  var runAbortFunctions = function () {
    if (!callbacked && !errbacked) {
      var i;
      for (i = 0; i < abortFunctions.length; ++i) {
        abortFunctions[i].apply(that, arguments);
      }
    }
  };

  this.propagateAbort = function () {
    if (aborted) {
      return;
    }
    aborted = true;
    abortArgs = arguments;
    runAbortFunctions();

    var i;
    for (i = 0; i < nextLinks.length; ++i) {
      nextLinks[i].propagateAbort();
    }
    // remove references so that memory can cleanup
    // later when we need it back
    branch = undefined;
    root = undefined;
  };

  this.abort = function () {
    if (aborted) {
      console.log("Deferred has already been aborted, can't abort again!");
      return that;
    }
    if (callbacked) {
      console.log("Deferred has already been callbacked, can't abort after that!");
      return that;
    }
    if (errbacked) {
      console.log("Deferred has already been errbacked, can't abort after that!");
      return that;
    }
    that.propagateAbort.apply(that, arguments);
    return that;
  };

  // abort this whole branch
  this.abortBranch = function () {
    branch.abort();
    return that;
  };

  // abort ALL deferreds
  this.abortAll = function () {
    if (root) {
      root.abort();
    } else {
      this.abort();
    }
    return that;
  };

  this.onAbort = function (abortFunction) {
    abortFunctions.push(abortFunction);
    if (aborted) {
      abortFunctions[abortFunctions.length - 1].apply(that, abortArgs);
    }
    return that;
  };

  this.progress = function (done, outOf) {
    if (aborted) {
      console.log("The deferred has been aborted, can't set progress!");
      return that;
    }
    var i;
    for (i = 0; i < progressFunctions.length; ++i) {
      progressFunctions[i](done, outOf);
    }
    return that;
  };

  this.onProgress = function (pf) {
    if (aborted) {
      console.log("The deferred has been aborted, won't register progress function!");
      return that;
    }
    progressFunctions.push(pf);
    if (done !== undefined && outOf !== undefined) {
      pf(done, outOf);
    }
    return that;
  };

  this.partialResult = function (partialResult) {
    if (aborted) {
      console.log("The deferred has been aborted, won't call partial result!");
      return that;
    }
    var i;
    for (i = 0; i < partialResultFunctions.length; ++i) {
      partialResultFunctions[i](partialResult);
    }
  };

  this.onPartialResult = function (prf) {
    if (aborted) {
      console.log("The deferred has been aborted, won't register partial result function!");
      return that;
    }
    partialResultFunctions.push(prf);
    return that;
  };

  this["finally"] = function () {
    that.andAtLast.apply(that, arguments);
  };

  this.andAtLast = function (finalFunction) {
    if (finallyFunction) {
      throw new Error("Finally function already exists");
    }
    finallyFunction = finalFunction;
  };

  return that;
};

Deferred.registerDefaultErrorHandler = function (handler) {
  Deferred.defaultErrorHandler = handler;
};

//
// Execute serveral deferreds in parallel, and let only one be returned.
// All return values from these deferreds are aggregated into the parameters
// of the one deferred object that is returned from this call.
// when(d1, d2)
// .then(function (d1Arg, d2Arg) {
//   // This will be done when d1 and d2 both has completed
// });
//
function when() {
  var d = new Deferred();
  var returnValues = [];
  var totalDeferreds = arguments.length;
  var deferredsDone = 0;

  // Check all arguments are deferreds.
  var i;
  for (i = 0; i < totalDeferreds; i += 1) {
    if (!(arguments[i] instanceof Deferred)) {
      throw new Error("Parameter with index " + i + " passed to select() is not a deferred object.");
    }
    var args = arguments;
    (function () {
      var index = i;
      args[index].then(function (retVal) {
        returnValues[index] = retVal;
        deferredsDone += 1;
        d.partialResult(returnValues);
        d.progress(deferredsDone, totalDeferreds);
        if (deferredsDone === totalDeferreds) {
          d.callback.apply(d, returnValues);
        }
      })
      .orIfError(function (e) {
        d.runErrback(e);
      });
    }());
  }
  return d;
}

//
// This is a variant of the parallel "when".
// The difference is that here the first deferred to complete is the one that will be returned from,
// all other are aborted.
//
// select(fetchDataFromWeb, timeout60s)
// .then(function (data) {
//   if (data === "timedOut") {
//     ...
//   } else if (data) {
//     ...
//   }
// });
//
function select() {
  var d = new Deferred();
  var done = false;
  var totalDeferreds = arguments.length;
  var winner;
  var args = arguments;
  var errored = false;

  // Check all arguments are deferreds.
  var i;
  for (i = 0; i < totalDeferreds; i += 1) {
    if (!(arguments[i] instanceof Deferred)) {
      throw new Error("Parameter with index " + i + " passed to select() is not a deferred object.");
    }
    (function () {
      var persistentI = i;
      args[persistentI].then(function (retVal) {
        if (done) {
          return;
        }
        done = true;
        d.callback(retVal);
        winner = args[persistentI];
        var i2;
        for (i2 = 0; i2 < totalDeferreds; i2 += 1) {
          if (args[i2] !== winner) {
            args[i2].abort();
          }
        }
      })
      .orIfError(function (e) {
        // Only one errback is allowed (and it is enough)
        if (!errored) {
          d.errback(e);
        }
        errored = true;
      });
    }());
  }
  // Hack not to get an error when using select without calling a .then on it.
  // Sometimes you don't want to do anything when the deferred callbacks, you
  // just want to use select to cancel the slower operation (e.g. a timeout)
  return d.then(function (args) {return args; });
}

////////////////////////////////
// TESTING GROUND STARTS HERE
////////////////////////////////

function wait(ms) {
  var d = new Deferred();
  setTimeout(function () {
    d.callback();
  }, ms);
  return d;
}

