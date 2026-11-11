void main(){
 vec4 c=texture(u_input,v_uv);vec3 rgb=clamp((c.rgb+vec3(p_brightness)-0.5)*p_contrast+0.5,0.0,1.0);
 rgb=pow(rgb,vec3(1.0/p_gamma));float gray=dot(rgb,vec3(0.2126,0.7152,0.0722));
 outColor=vec4(clamp(mix(vec3(gray),rgb,p_saturation),0.0,1.0),c.a);
}
