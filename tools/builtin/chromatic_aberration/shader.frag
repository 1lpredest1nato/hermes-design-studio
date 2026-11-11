void main(){
 float a=radians(p_angle);vec2 shift=vec2(cos(a),sin(a))*p_offset/u_resolution;vec4 c=texture(u_input,v_uv);
 outColor=vec4(texture(u_input,v_uv+shift).r,c.g,texture(u_input,v_uv-shift).b,c.a);
}
