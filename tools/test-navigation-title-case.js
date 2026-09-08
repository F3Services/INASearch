const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/INASearch.template.html'), 'utf8');
const start = source.indexOf('    function navigationTitleCase(');
const end = source.indexOf('    function statuteStatus(', start);
const titleCase = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
for (const [input, expected] of [
  ['TABLE OF CONTENTS', 'Table of Contents'],
  ['ADJUSTMENT AND CHANGE OF STATUS', 'Adjustment and Change of Status'],
  ['ALIEN TERRORIST REMOVAL PROCEDURES', 'Alien Terrorist Removal Procedures'],
  ['Application for naturalization', 'Application for Naturalization'],
  ['THE RIGHT TO BE HEARD', 'The Right to Be Heard'],
  ['RULES: THE RIGHT TO APPEAL', 'Rules: The Right to Appeal'],
  ['WHAT THE RULE IS FOR', 'What the Rule Is For'],
  ['USCIS and DHS procedures under INA 101(a)(15)(J)', 'USCIS and DHS Procedures under INA 101(a)(15)(J)'],
  ['TITLE IV—ADJUSTMENT OF STATUS', 'Title IV—Adjustment of Status'],
  ['CIVIL PENALTIES', 'Civil Penalties'],
  ['eCFR and GovInfo listings', 'eCFR and GovInfo Listings'],
  ['McCarran-Walter Act', 'McCarran-Walter Act'],
  ['EMPLOYMENT-BASED IMMIGRANTS', 'Employment-Based Immigrants'],
  ['U.S.C. and CFR citations', 'U.S.C. and CFR Citations'],
  ["ALIEN’S APPLICATION", "Alien’s Application"],
  ['', '']
]) {
  assert.equal(titleCase(input), expected, input);
  assert.equal(titleCase(expected), expected, `Idempotence: ${expected}`);
}
console.log('Navigation title-case tests passed.');
