vec3 toSrgb(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}
void main(){
 vec4 c=texture(u_input,v_uv);float t=dot(c.rgb,vec3(0.2126,0.7152,0.0722));vec3 mapped=mix(p_dark,p_light,t);
 if(p_three_colors)mapped=t<0.5?mix(p_dark,p_middle,t*2.0):mix(p_middle,p_light,t*2.0-1.0);
 outColor=vec4(toSrgb(mapped),c.a);
}
