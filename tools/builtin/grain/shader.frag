void main(){
 uvec2 pixel=uvec2(floor(v_uv*u_resolution));uint seed=uint(mod(abs(u_seed),16777216.0));
 uint n=pixel.x*1973u+pixel.y*9277u+seed*26699u;n=(n^(n>>13u))*1274126177u;n=n^(n>>16u);
 float noise=float(n&65535u)/65535.0-0.5;vec4 c=texture(u_input,v_uv);
 outColor=vec4(clamp(c.rgb+vec3(noise*p_amount),0.0,1.0),c.a);
}
