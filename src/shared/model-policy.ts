export function isModelRetired(model:{retire_at?:string}, timezone:string, at=new Date()):boolean {
  return !!model.retire_at && new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(at) >= model.retire_at;
}
