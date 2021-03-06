/*
  This file is part of the lps.js project, released open source under
  the BSD 3-Clause license. For more info, please see https://github.com/mauris/lps.js
 */

const lpsRequire = require('../lpsRequire');
const LiteralTreeMap = lpsRequire('engine/LiteralTreeMap');
const FunctorProvider = lpsRequire('engine/FunctorProvider');
const StaticAnalyzer = lpsRequire('engine/StaticAnalyzer');

const processRules = lpsRequire('utility/processRules');
const goalTreeSorter = lpsRequire('utility/goalTreeSorter');
const EventManager = lpsRequire('utility/observer/Manager');
const Profiler = lpsRequire('utility/profiler/Profiler');
const constraintCheck = lpsRequire('utility/constraintCheck');
const stringLiterals = lpsRequire('utility/strings');
const evaluateGoalTrees = lpsRequire('utility/evaluateGoalTrees');
const updateStateWithFluentActors = lpsRequire('utility/updateStateWithFluentActors');

const builtinProcessor = lpsRequire('engine/builtin/builtin');
const observeProcessor = lpsRequire('engine/processors/observe');
const initiallyProcessor = lpsRequire('engine/processors/initially');
const ruleAntecedentProcessor = lpsRequire('engine/processors/ruleAntecedent');
const settingsProcessor = lpsRequire('engine/processors/settings');
const timableProcessor = lpsRequire('engine/processors/timable');
const coreModule = lpsRequire('engine/modules/core');

const forEachToString = (arr) => {
  return (item) => {
    arr.push(item.toString());
  };
};

const ERROR_EVENT = 'error';
const DONE_EVENT = 'done';

/**
 * Start a continuous execution that will start the next cycle as soon as the current cycle ends.
 */
const startContinuousExecution = (engine, eventManager, cycleInterval) => {
  const continuousExecutionFunc = () => {
    if (engine.isPaused() || engine.hasHalted()) {
      return;
    }

    // schedule next cycle ahead
    let timer = setTimeout(continuousExecutionFunc, cycleInterval);

    engine.step()
      .then(() => {
        if (engine.hasHalted()) {
          eventManager.notify(DONE_EVENT, engine);
          return;
        }
        clearTimeout(timer);
        setImmediate(continuousExecutionFunc);
      })
      .catch((err) => {
        engine.halt();
        clearTimeout(timer);
        eventManager.notify(ERROR_EVENT, err);
      });
  };
  setImmediate(continuousExecutionFunc);
};

/**
 * Start a normal execution that starts the cycle using the specified cycle interval.
 */
const startNormalExecution = (engine, eventManager, cycleInterval) => {
  let timer = setInterval(() => {
    if (engine.hasHalted()) {
      clearInterval(timer);
      eventManager.notify(DONE_EVENT, engine);
      return;
    }
    if (engine.isPaused()) {
      clearInterval(timer);
      return;
    }
    engine.step()
      .catch((err) => {
        clearInterval(timer);
        eventManager.notify(ERROR_EVENT, err);
      });
  }, cycleInterval);
};

const DEFAULT_MAX_TIME = 20;
const DEFAULT_CYCLE_INTERVAL = 100;

function Engine(programArg) {
  let _program = programArg;
  let _maxTime = DEFAULT_MAX_TIME;
  let _cycleInterval = DEFAULT_CYCLE_INTERVAL; // milliseconds
  let _isContinuousExecution = false;
  let _isInCycle = false;
  let _isPaused = false;
  let _isRunning = false;
  let _isLoaded = false;

  const _engineEventManager = new EventManager();
  const _profiler = new Profiler();

  let _observations = {};

  let _goals = [];

  let _currentTime = 0;

  let _nextCycleObservations = new LiteralTreeMap();
  let _nextCycleActions = new LiteralTreeMap();

  let _lastCycleActions = null;
  let _lastCycleObservations = null;

  const _functorProvider = new FunctorProvider(this);

  const checkConstraintSatisfaction = function checkConstraintSatisfaction(otherProgram) {
    let originalProgram = _program;
    _program = otherProgram;
    let result = constraintCheck(this, otherProgram);
    _program = originalProgram;
    return result;
  };

  /**
   * Process observations for the current cycle
   * @return {LiteralTreeMap} Returns the set of observed event for the current time.
   */
  const processCycleObservations = function processCycleObservations() {
    let activeObservations = new LiteralTreeMap();

    if (_observations[_currentTime] === undefined) {
      // no observations for current time
      return activeObservations;
    }
    let cloneProgram = _program.clone();
    cloneProgram.setExecutedActions(activeObservations);

    const nextTime = _currentTime + 1;

    // process observations for the current time
    _observations[_currentTime].forEach((ob) => {
      let action = ob.action;

      let tempTreeMap = new LiteralTreeMap();
      tempTreeMap.add(action);

      activeObservations.add(action);

      let postCloneProgram = cloneProgram.clone();
      let postState = postCloneProgram.getState();
      postCloneProgram.setExecutedActions(new LiteralTreeMap());
      updateStateWithFluentActors(
        this,
        tempTreeMap,
        postState
      );
      postCloneProgram.setState(postState);

      // perform pre-check and post-check
      if (!checkConstraintSatisfaction.call(this, cloneProgram)
          || !checkConstraintSatisfaction.call(this, postCloneProgram)) {
        // reject the observed event
        // to keep model true
        activeObservations.remove(action);

        // warning
        _engineEventManager.notify('warning', {
          type: 'observation.reject',
          message: stringLiterals(
            'engine.rejectObservationWarning',
            action,
            _currentTime,
            nextTime
          )
        });
      }

      // if the given observation endTime has not ended
      // propagate to the next cycle's
      if (ob.endTime > nextTime) {
        if (_observations[nextTime] === undefined) {
          _observations[nextTime] = [];
        }
        _observations[nextTime].push(ob);
      }
    });

    return activeObservations;
  };

  /**
   * Select the appropriate set of actions from the given goal trees such that
   * constraints are not violated for the current cycle.
   * @param  {Array<GoalTree>} goalTrees The goal trees to choose actions from
   * @return {LiteralTreeMap}            The set of actions chosen to execute
   */
  const actionsSelector = function actionsSelector(goalTrees) {
    const recursiveActionsSelector = (actionsSoFar, programSoFar, l) => {
      if (l >= goalTrees.length) {
        let actions = new LiteralTreeMap();
        actionsSoFar.forEach((map) => {
          map.forEach((literal) => {
            actions.add(literal);
          });
        });
        return actions;
      }
      let goalTree = goalTrees[l];
      let resultSet = null;
      goalTree.forEachCandidateActions(_currentTime, (candidateActions) => {
        let cloneProgram = programSoFar.clone();

        let cloneExecutedActions = cloneProgram.getExecutedActions();
        candidateActions.forEach((a) => {
          cloneExecutedActions.add(a);
        });

        // pre-condition check
        if (!checkConstraintSatisfaction.call(this, cloneProgram)) {
          return false;
        }

        // post condition checks
        let clonePostProgram = programSoFar.clone();
        clonePostProgram.setExecutedActions(new LiteralTreeMap());
        let postState = clonePostProgram.getState();
        updateStateWithFluentActors(
          this,
          candidateActions,
          postState
        );
        clonePostProgram.setState(postState);

        if (!checkConstraintSatisfaction.call(this, clonePostProgram)) {
          return false;
        }

        resultSet = recursiveActionsSelector(
          actionsSoFar.concat([candidateActions]),
          cloneProgram,
          l + 1
        );
        return true;
      });

      if (resultSet !== null) {
        return resultSet;
      }

      return recursiveActionsSelector(
        actionsSoFar,
        programSoFar,
        l + 1
      );
    };

    return recursiveActionsSelector([], _program, 0);
  };

  /**
   * Performs the state transition for a single cycle.
   * @return {Promise} Returns a promise that when fulfilled, indicates the completion of the
   *                   cycle processing.
   */
  const performCycle = function performCycle() {
    _currentTime += 1;

    let selectedAndExecutedActions = new LiteralTreeMap();
    let executedObservations = new LiteralTreeMap();

    // Step 0 - Updating database
    let updatedState = _program.getState().clone();
    updateStateWithFluentActors(
      this,
      _program.getExecutedActions(),
      updatedState
    );
    _program.setState(updatedState);

    _nextCycleObservations.forEach((obs) => {
      executedObservations.add(obs);
    });
    _nextCycleActions.forEach((act) => {
      selectedAndExecutedActions.add(act);
    });

    // Step 1 - Processing rules
    let newFiredGoals = processRules(this, _program, _currentTime, _profiler);
    _goals = _goals.concat(newFiredGoals);

    // Step 3 - Processing
    return evaluateGoalTrees(_currentTime, _goals, _profiler)
      .then((newGoals) => {
        _goals = newGoals;

        // Start preparation for next cycle

        // reset the set of executed actions
        _program.setExecutedActions(new LiteralTreeMap());
        _goals.sort(goalTreeSorter(_currentTime));

        // select actions from candidate actions
        return actionsSelector.call(this, _goals);
      })
      .then((nextCycleActions) => {
        _nextCycleActions = new LiteralTreeMap();
        nextCycleActions.forEach((l) => {
          _nextCycleActions.add(l);
        });
        _nextCycleObservations = new LiteralTreeMap();
        let cycleObservations = processCycleObservations.call(this);
        cycleObservations.forEach((observation) => {
          nextCycleActions.add(observation);
          _nextCycleObservations.add(observation);
        });

        _program.setExecutedActions(nextCycleActions);

        _lastCycleActions = selectedAndExecutedActions;
        _lastCycleObservations = executedObservations;

        // done with cycle
        return Promise.resolve();
      });
  };

  /**
   * Get the profiler object keeping track of statistics for this engine
   * @return {Profiler} Returns the profiler object
   */
  this.getProfiler = function getProfiler() {
    return _profiler;
  };

  /**
   * Get the current time of the LPS program under execution
   * @return {number} Returns the current time
   */
  this.getCurrentTime = function getCurrentTime() {
    return _currentTime;
  };

  /**
   * Get the maximum execution time for the LPS program
   * @return {number} Returns the maximum execution time.
   */
  this.getMaxTime = function getMaxTime() {
    return _maxTime;
  };

  /**
   * Set the maximum execution time for the LPS program.
   * Can only be set before the execution of the LPS program starts.
   * @param {number} newMaxTime The new maximum execution time. Must be positive non-zero integer.
   * @throws Throws an error when an invalid new maximum execution time is given or trying to set
   *         the maximum execution time after execution has started.
   */
  this.setMaxTime = function setMaxTime(newMaxTime) {
    if (_isRunning) {
      throw stringLiterals.error(
        'engine.updatingParametersWhileRunning',
        'max cycle time'
      );
    }
    if (newMaxTime <= 0
        || !Number.isInteger(newMaxTime)) {
      throw stringLiterals.error('engine.nonPositiveIntegerMaxTime', newMaxTime);
    }

    _maxTime = newMaxTime;
  };

  /**
   * Check if the program execution is in cycle.
   * @return {Boolean} Returns true if cycle processing is in progress.
   */
  this.isInCycle = function isInCycle() {
    return _isInCycle;
  };

  /**
   * Check if the LPS program is running.
   * @return {Boolean} Returns true if the program has started running, but not halted yet.
   */
  this.isRunning = function isRunning() {
    return _isRunning;
  };

  /**
   * Check if the LPS program is currently paused in execution.
   * @return {Boolean} Returns true if the program is currently paused.
   */
  this.isPaused = function isPaused() {
    return _isPaused;
  };

  /**
   * Get the amount of set time between start of cycles
   * @return {number} Returns the cycle interval in milliseconds.
   */
  this.getCycleInterval = function getCycleInterval() {
    return _cycleInterval;
  };

  /**
   * Set the cycle interval between start of cycles for the LPS program.
   * Can only be set before the execution of the LPS program starts.
   * @param {number} newCycleInterval The new cycle interval. Must be positive non-zero integer.
   * @throws Throws an error when an invalid new cycle interval is given or trying to set
   *         the cycle interval after execution has started.
   */
  this.setCycleInterval = function setCycleInterval(newCycleInterval) {
    if (_isRunning) {
      throw stringLiterals.error('engine.updatingParametersWhileRunning', 'cycle interval');
    }
    if (typeof newCycleInterval !== 'number') {
      throw stringLiterals.error(
        'engine.parameterInvalidType',
        1,
        'Engine.setCycleInterval',
        'number',
        typeof val
      );
    }
    if (newCycleInterval <= 0
        || !Number.isInteger(newCycleInterval)) {
      throw stringLiterals.error('engine.nonPositiveIntegerCycleInterval', newCycleInterval);
    }
    _cycleInterval = newCycleInterval;
  };

  this.isContinuousExecution = function isContinuousExecution() {
    return _isContinuousExecution;
  };

  this.setContinuousExecution = function setContinuousExecution(val) {
    if (_isRunning) {
      throw stringLiterals.error(
        'engine.updatingParametersWhileRunning',
        'continuous execution mode'
      );
    }
    if (typeof val !== 'boolean') {
      throw stringLiterals.error(
        'engine.parameterInvalidType',
        1,
        'Engine.setContinuousExecution',
        'boolean',
        typeof val
      );
    }
    _isContinuousExecution = val;
  };

  this.getLastCycleActions = function getLastCycleActions() {
    let actions = [];
    if (_lastCycleActions === null) {
      return actions;
    }
    _lastCycleActions.forEach(forEachToString(actions));
    return actions;
  };

  this.getLastCycleObservations = function getLastCycleObservations() {
    let observations = [];
    if (_lastCycleObservations === null) {
      return observations;
    }
    _lastCycleObservations.forEach(forEachToString(observations));
    return observations;
  };

  this.getTimelessFacts = function getTimelessFacts() {
    let facts = [];
    _program.getFacts()
      .forEach(forEachToString(facts));
    return facts;
  };

  this.getActiveFluents = function getActiveFluents() {
    let fluents = [];
    _program.getState()
      .forEach(forEachToString(fluents));
    return fluents;
  };

  this.query = function query(literalArg, type) {
    try {
      let literal = literalArg;
      if (type === 'fluent') {
        return _program.getState().unifies(literal);
      }

      if (type === 'action') {
        return _lastCycleActions.unifies(literal);
      }

      if (type === 'observation') {
        return _lastCycleObservations.unifies(literal);
      }

      return _program.query(literal, this);
    } catch (err) {
      this.halt();
      _engineEventManager.notify(ERROR_EVENT, err);
    }
    return [];
  };

  this.hasHalted = function hasHalted() {
    return _maxTime !== null
      && _currentTime >= _maxTime;
  };

  this.halt = function halt() {
    _maxTime = _currentTime;
    if (_isPaused) {
      _engineEventManager.notify(DONE_EVENT, this);
    }
    _isPaused = false;
  };

  /**
   * Perform a single cycle processing / state transition
   * @return {Promise} Returns a promise that when fulfilled indicates the processing completion
   */
  this.step = function step() {
    if (_isInCycle) {
      // previous cycle has not ended.
      this.halt();
      let error = stringLiterals.error(['engine', 'cycleIntervalExceeded'], [_cycleInterval]);
      return Promise.reject(error);
    }
    if (_isPaused) {
      // cancel execution since engine is paused.
      return Promise.resolve();
    }
    if (this.hasHalted()) {
      // cancel exection since engine has halted.
      return Promise.resolve();
    }
    _engineEventManager.notify('preCycle', this);

    // reset statistics
    _profiler.set('lastCycleNumFiredRules', 0);
    _profiler.set('lastCycleNumFailedGoals', 0);
    _profiler.set('lastCycleNumResolvedGoals', 0);
    _profiler.set('lastCycleNumNewRules', 0);
    _profiler.set('lastCycleNumDiscardedRules', 0);

    _isInCycle = true;
    let startTime = Date.now();
    // perform state transition using performCycle function
    return performCycle.call(this)
      .then(() => {
        _profiler.set('lastCycleExecutionTime', Date.now() - startTime);

        // update statistics
        _profiler.set('numState', _program.getState().size());
        _profiler.set('lastCycleNumUnresolvedGoals', _goals.length);
        _profiler.set('lastCycleNumActions', _lastCycleActions.size());
        _profiler.set('lastCycleNumObservations', _lastCycleObservations.size());

        _isInCycle = false;
        _engineEventManager.notify('postCycle', this);
      });
  };

  /**
   * Start the execution of the LPS program
   */
  this.run = function run() {
    if (_maxTime <= 0) {
      throw stringLiterals.error('engine.maxTimeInvalid', _maxTime);
    }
    if (this.hasHalted()) {
      return;
    }
    _isRunning = true;
    _engineEventManager.notify('run', this);

    if (_isContinuousExecution) {
      startContinuousExecution(this, _engineEventManager, _cycleInterval);
      return;
    }
    startNormalExecution(this, _engineEventManager, _cycleInterval);
  };

  this.define = function define(name, callback) {
    if (_isRunning) {
      throw stringLiterals.error('engine.definePredicatesWhileRunning');
    }
    _functorProvider.define(name, callback);
  };

  this.getFunctorProvider = function getFunctorProvider() {
    return _functorProvider;
  };

  this.on = function on(event, listener) {
    _engineEventManager.addListener(event, listener);
    return this;
  };

  this.observe = function observe(observation) {
    let scheduledTime = _currentTime;
    if (scheduledTime === 0) {
      scheduledTime = 1;
    }
    this.scheduleObservation(observation, scheduledTime);
  };

  /**
   * Pause the LPS program execution. If the program is in a cycle processing,
   * it will pause after the cycle processing ends.
   */
  this.pause = function pause() {
    if (this.hasHalted()) {
      return;
    }
    _isPaused = true;
    _engineEventManager.notify('paused', this);
    _profiler.increment('numPaused');
  };

  /**
   * Unpause and resume the LPS program execution from its current state.
   */
  this.unpause = function unpause() {
    if (this.hasHalted()) {
      return;
    }
    _isPaused = false;
    _engineEventManager.notify('unpaused', this);
    if (_isContinuousExecution) {
      startContinuousExecution(this, _engineEventManager, _cycleInterval);
      return;
    }
    startNormalExecution(this, _engineEventManager, _cycleInterval);
  };

  this.loadModule = function loadModule(module) {
    if (_isRunning) {
      throw stringLiterals.error('engine.definePredicatesWhileRunning');
    }
    if (typeof module !== 'function') {
      throw stringLiterals.error('engine.loadModuleInvalidType');
    }
    return module(this, _program);
  };

  this.scheduleObservation = function scheduleObservation(observation, startTimeArg, endTimeArg) {
    let startTime = startTimeArg;
    let endTime = endTimeArg;
    if (startTime === undefined
        || startTime < _currentTime) {
      throw stringLiterals.error(
        'engine.invalidStartTimeObservationScheduling',
        [observation, startTime, _currentTime]
      );
    }

    if (startTime === _currentTime && _isInCycle) {
      // already in a cycle, so process it in the next cycle
      startTime += 1;
    }

    if (endTime === undefined) {
      // default endTime is given by 1 after the startTime
      endTime = startTime + 1;
    }

    if (endTime <= startTime) {
      // invalid endTime given
      throw stringLiterals.error(
        'engine.invalidObservationScheduling',
        [observation, startTime, endTime]
      );
    }

    if (_observations[startTime] === undefined) {
      _observations[startTime] = [];
    }

    let processSingleObservation = (obsArg) => {
      let obs = obsArg;
      _observations[startTime].push({
        action: obs,
        endTime: endTime
      });
    };

    if (observation instanceof Array) {
      observation.forEach((obs) => {
        processSingleObservation(obs);
      });
      return;
    }
    processSingleObservation(observation);
  };

  // we preprocess some of the built-in processors by looking at the facts
  // of the _program.
  this.on('loaded', () => {
    StaticAnalyzer.analyze(_program, _engineEventManager);
    settingsProcessor(this, _program);
    timableProcessor(this, _program);
    initiallyProcessor(this, _program);
    observeProcessor(this, _program);
    ruleAntecedentProcessor(this, _program);
  });

  this.load = function load() {
    if (_isLoaded) {
      return Promise.reject(stringLiterals.error('engine.loadingLoadedEngine'));
    }
    // load once only
    _isLoaded = true;
    coreModule(this, _program);

    return builtinProcessor(this, _program)
      .then(() => {
        if (process.browser) {
          // skip consult processing for browser context
          return Promise.resolve();
        }
        const consultProcessor = lpsRequire('engine/processors/consult');
        // start processing consult/1, consult/2 and loadModule/1 declarations in main program
        return consultProcessor(this, _program);
      })
      .then(() => {
        return _engineEventManager.notify('loaded', this);
      })
      .then(() => {
        _engineEventManager.notify('ready', this);
        return Promise.resolve(this);
      });
  };


  _profiler.set('numPaused', 0);
}

module.exports = Engine;
