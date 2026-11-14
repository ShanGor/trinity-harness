/** Fixed SHA-256 for renderer contexts where WebCrypto is unavailable (ordinary HTTP). */
export const documentDigestScript = `text=>{
  const bytes=new TextEncoder().encode(text),length=bytes.length;
  const padded=new Uint8Array(Math.ceil((length+9)/64)*64);padded.set(bytes);padded[length]=128;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-4,length*8,false);
  const primes=[];for(let p=2;primes.length<64;p++){if(primes.every(q=>p%q!==0))primes.push(p);}
  const k=primes.map(p=>(Math.cbrt(p)%1*4294967296)>>>0);
  const h=primes.slice(0,8).map(p=>(Math.sqrt(p)%1*4294967296)>>>0);
  const r=(x,n)=>(x>>>n)|(x<<(32-n)),w=new Uint32Array(64);
  for(let offset=0;offset<padded.length;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4,false);
    for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,z]=h;
    for(let i=0;i<64;i++){const t=(z+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0;const u=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}
    [a,b,c,d,e,f,g,z].forEach((v,i)=>{h[i]=(h[i]+v)>>>0;});
  }
  return h.map(v=>v.toString(16).padStart(8,'0')).join('');
}`;
