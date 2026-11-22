use notarium_search::vector::simd::{Dot, Kernel, dot_i8_scalar};
use proptest::{
    collection::vec,
    prelude::*,
    test_runner::{Config, TestRunner},
};

#[test]
fn simd_matches_scalar_bit_for_bit() {
    let vectors = prop::sample::select(vec![64, 100, 384, 768, 1024, 1536])
        .prop_flat_map(|dim| (vec(-127i8..=127, dim), vec(-127i8..=127, dim)));
    let mut runner = TestRunner::new(Config {
        cases: 10_000,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&vectors, |(query, value)| {
            let expected = dot_i8_scalar(&query, &value);
            for kernel in Kernel::ALL.into_iter().filter(|kernel| kernel.available()) {
                let actual = Dot::with_kernel(&query, kernel).unwrap().dot(&value);
                prop_assert_eq!(actual, expected);
            }
            Ok(())
        })
        .unwrap();
    for dim in [64, 100, 384, 768, 1024, 1536, 4096] {
        let query = vec![-127; dim];
        let value = vec![127; dim];
        for kernel in Kernel::ALL.into_iter().filter(|kernel| kernel.available()) {
            let dot = Dot::with_kernel(&query, kernel).unwrap();
            assert_eq!(dot.dot(&value), Some(-127 * 127 * dim as i32));
            assert_eq!(dot.dot(&vec![0; dim]), Some(0));
        }
    }
}
