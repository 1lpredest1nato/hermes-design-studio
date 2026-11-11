void main(){
 vec2 pixel=v_uv*u_resolution;
 vec2 center=(floor(pixel/float(p_size))+0.5)*float(p_size);
 outColor=texture(u_input,min(center,u_resolution-0.5)/u_resolution);
}
