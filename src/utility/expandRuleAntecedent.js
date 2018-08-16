/*
  This file is part of the lps.js project, released open source under
  the BSD 3-Clause license. For more info, please see https://github.com/mauris/lps.js
 */

const expandLiteral = lpsRequire('utility/expandLiteral');
const variableArrayRename = lpsRequire('utility/variableArrayRename');

module.exports = function expandRuleAntecedent(result, literals, thetaPath, program) {
  let isLeaf = true;

  let literalsLength = literals.length;
  let usedVariables = {};
  literals.forEach((literal) => {
    literal.getVariableHash(usedVariables);
  });
  usedVariables = Object.keys(usedVariables);
  let renameTheta = variableArrayRename(usedVariables);

  for (let i = 0; i < literalsLength; i += 1) {
    let literal = literals[i];
    let otherLiteralsFront = literals.slice(0, i);
    let otherLiteralsBack = literals.slice(i + 1, literalsLength);

    let expansionResult = expandLiteral(literal, program, renameTheta);
    if (expansionResult.length > 0) {
      isLeaf = false;
    }

    expansionResult.forEach((crrArg) => {
      // crr needs to rename variables to avoid clashes
      // also at the same time handle any output variables
      let remappedClauseFront = otherLiteralsFront.map((l) => {
        return l
          .substitute(crrArg.theta);
      });
      let remappedClauseBack = otherLiteralsBack.map((l) => {
        return l
          .substitute(crrArg.theta);
      });
      let newRule = remappedClauseFront
        .concat(crrArg.clause)
        .concat(remappedClauseBack);
      // check and expand the new antecedent again
      expandRuleAntecedent(result, newRule, thetaPath.concat([crrArg.theta]), program);
    });
    if (!isLeaf) {
      break;
    }
  }

  if (isLeaf) {
    result.push({
      thetaPath: thetaPath,
      literalSet: literals
    });
  }
};
