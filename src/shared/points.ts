export type MonthlyPoints={allowance:number;remaining:number|null};
export function monthlyPercent(value:{monthly?:MonthlyPoints|null}):number|null{
 const m=value.monthly;return m&&m.remaining!==null&&m.allowance>0?100*m.remaining/m.allowance:null;
}
export function otherPoints(value:{remaining:number|null;monthly?:MonthlyPoints|null}):number|null{
 return value.remaining!==null&&value.monthly?.remaining!=null?Math.round((value.remaining-value.monthly.remaining)*1000)/1000:null;
}
