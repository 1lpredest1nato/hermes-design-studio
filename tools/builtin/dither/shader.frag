vec3 toSrgb(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}
int rank2(ivec2 p){return ((p.x ^ p.y)&1)*2+(p.y&1);}
void main(){
 ivec2 pixel=ivec2(floor(v_uv*u_resolution));int n=2<<p_matrix;
 int rank=rank2(pixel);if(n>=4)rank=rank*4+rank2(pixel>>1);if(n>=8)rank=rank*4+rank2(pixel>>2);
 vec4 c=texture(u_input,v_uv);float value=dot(c.rgb,vec3(0.2126,0.7152,0.0722));
 int levels=p_use_palette?2:p_levels;
 float q=clamp(floor(value*float(levels-1)+(float(rank)+0.5)/float(n*n))/float(levels-1),0.0,1.0);
 outColor=vec4(p_use_palette?toSrgb(mix(p_dark,p_light,q)):vec3(q),c.a);
}
