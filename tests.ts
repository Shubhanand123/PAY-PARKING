import { charge, checkPlate } from './engine.ts'
const car = { firstHours: 2, firstPaise: 3000, perHourPaise: 2000, capPaise: 30000 }
const cases: [number, number][] = [[5,0],[6,3000],[80,3000],[120,3000],[121,5000],[140,5000],[181,7000],[24*60,30000],[24*60+3,30000],[24*60+10,33000],[48*60+200,67000]]
let ok=true
for (const [m,exp] of cases){const r=charge(m,car,5).total; if(r!==exp){ok=false;console.log('FAIL',m,r,exp)}}
console.log(ok?'tariff ok':'tariff fail')
for (const p of ['mh12ab1234','MH 12 AB 1234','22BH1234AA','DL3CAB1234','MHI2AB12O4','KA01A1234','XY1'] ) console.log(p, JSON.stringify(checkPlate(p)))
