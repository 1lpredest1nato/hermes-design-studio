void main(){
 vec4 c=texture(u_input,v_uv);float a=radians(p_angle);vec2 pixel=v_uv*u_resolution;
 vec2 rotated=vec2(cos(a)*pixel.x-sin(a)*pixel.y,sin(a)*pixel.x+cos(a)*pixel.y);
 vec2 d=fract(rotated/p_size)-0.5;float ink=(1.0-dot(c.rgb,vec3(0.2126,0.7152,0.0722)))*0.25;
 float paper=dot(d,d)<=ink?0.0:1.0;outColor=vec4(vec3(paper),c.a);
}
